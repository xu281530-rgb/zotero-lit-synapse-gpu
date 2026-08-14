#include "vector_index.hpp"

#include <fcntl.h>
#include <io.h>
#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <exception>
#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace {

using json = nlohmann::json;
using zotero_gpu::IncomingRow;
using zotero_gpu::ItemIdentity;
using zotero_gpu::SearchOptions;
using zotero_gpu::VectorPrecision;
using zotero_gpu::VectorGpuError;
using zotero_gpu::VectorIndex;

constexpr std::uint32_t kMaxHeaderBytes = 8U * 1024U * 1024U;
constexpr std::uint32_t kMaxPayloadBytes = 32U * 1024U * 1024U;
constexpr const char* kProtocol = "vector-gpu/2";

struct Frame {
  json header;
  std::vector<std::uint8_t> payload;
};

bool read_exact(void* destination, std::size_t length) {
  auto* bytes = static_cast<char*>(destination);
  std::size_t offset = 0;
  while (offset < length) {
    std::cin.read(bytes + offset,
                  static_cast<std::streamsize>(length - offset));
    const std::streamsize count = std::cin.gcount();
    if (count <= 0) return false;
    offset += static_cast<std::size_t>(count);
  }
  return true;
}

bool read_frame(Frame& frame) {
  std::uint32_t header_length = 0;
  if (!read_exact(&header_length, sizeof(header_length))) return false;
  if (header_length == 0 || header_length > kMaxHeaderBytes) {
    throw VectorGpuError("INVALID_FRAME", "Invalid protocol header length");
  }
  std::string header(header_length, '\0');
  if (!read_exact(header.data(), header.size())) {
    throw VectorGpuError("INVALID_FRAME", "Truncated protocol header");
  }
  std::uint32_t payload_length = 0;
  if (!read_exact(&payload_length, sizeof(payload_length)) ||
      payload_length > kMaxPayloadBytes) {
    throw VectorGpuError("INVALID_FRAME", "Invalid protocol payload length");
  }
  frame.payload.resize(payload_length);
  if (payload_length > 0 &&
      !read_exact(frame.payload.data(), frame.payload.size())) {
    throw VectorGpuError("INVALID_FRAME", "Truncated protocol payload");
  }
  try {
    frame.header = json::parse(header);
  } catch (const std::exception& error) {
    throw VectorGpuError("INVALID_FRAME",
                         std::string("Invalid JSON header: ") + error.what());
  }
  if (!frame.header.is_object() ||
      frame.header.value("protocol", "") != kProtocol ||
      !frame.header.contains("requestId") ||
      !frame.header["requestId"].is_string() ||
      !frame.header.contains("type") || !frame.header["type"].is_string()) {
    throw VectorGpuError("INVALID_FRAME", "Invalid protocol envelope");
  }
  return true;
}

void write_frame(const json& header) {
  const std::string encoded = header.dump();
  const std::uint32_t header_length =
      static_cast<std::uint32_t>(encoded.size());
  const std::uint32_t payload_length = 0;
  std::cout.write(reinterpret_cast<const char*>(&header_length),
                  sizeof(header_length));
  std::cout.write(encoded.data(), static_cast<std::streamsize>(encoded.size()));
  std::cout.write(reinterpret_cast<const char*>(&payload_length),
                  sizeof(payload_length));
  std::cout.flush();
}

json success(const Frame& request) {
  return {{"protocol", kProtocol},
          {"type", request.header.value("type", "") + ".result"},
          {"requestId", request.header.value("requestId", "")},
          {"ok", true}};
}

void write_error(const Frame& request, const std::string& code,
                 const std::string& message) {
  write_frame({{"protocol", kProtocol},
               {"type", "error"},
               {"requestId", request.header.value("requestId", "")},
               {"ok", false},
               {"code", code},
               {"message", message}});
}

std::vector<IncomingRow> parse_rows(const json& header) {
  std::vector<IncomingRow> rows;
  for (const json& value : header.value("rows", json::array())) {
    IncomingRow row;
    row.row_id = value.at("rowId").get<std::int64_t>();
    row.library_id = value.at("libraryID").get<std::int64_t>();
    row.item_key = value.at("itemKey").get<std::string>();
    row.chunk_id = value.at("chunkId").get<std::int32_t>();
    row.language = value.at("language").get<std::string>();
    rows.push_back(std::move(row));
  }
  return rows;
}

VectorPrecision parse_precision(const json& header) {
  const std::string value = header.value("precision", "");
  if (value == "float32") return VectorPrecision::Float32;
  if (value == "int8") return VectorPrecision::Int8;
  throw VectorGpuError("INVALID_FRAME", "precision must be float32 or int8");
}

void require_precision(const VectorIndex& index, const json& header) {
  if (parse_precision(header) != index.precision()) {
    throw VectorGpuError("INVALID_FRAME",
                         "Command precision does not match the resident index");
  }
}

ItemIdentity parse_item(const json& value) {
  return {value.at("libraryID").get<std::int64_t>(),
          value.at("itemKey").get<std::string>()};
}

void secure_dll_search_path() {
  SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_APPLICATION_DIR |
                           LOAD_LIBRARY_SEARCH_SYSTEM32 |
                           LOAD_LIBRARY_SEARCH_USER_DIRS);
  wchar_t executable[MAX_PATH]{};
  const DWORD length = GetModuleFileNameW(nullptr, executable, MAX_PATH);
  if (length == 0 || length >= MAX_PATH) return;
  std::wstring directory(executable, executable + length);
  const std::size_t separator = directory.find_last_of(L"\\/");
  if (separator != std::wstring::npos) {
    directory.resize(separator);
    AddDllDirectory(directory.c_str());
    SetCurrentDirectoryW(directory.c_str());
  }
}

}  // namespace

int main(int argc, char** argv) {
  secure_dll_search_path();
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  if (argc != 2 || std::string(argv[1]) != "--stdio") return 64;

  std::unique_ptr<VectorIndex> index;
  for (;;) {
    Frame request;
    try {
      if (!read_frame(request)) break;
      const std::string type = request.header.at("type").get<std::string>();
      if (type == "hello") {
        if (request.header.value("expectedProtocol", "") != kProtocol) {
          throw VectorGpuError("INVALID_FRAME", "Protocol version mismatch");
        }
        index = std::make_unique<VectorIndex>();
        const auto memory = index->memory_info();
        json response = success(request);
        response["device"] = index->device_name();
        response["protocolVersion"] = kProtocol;
        response["totalMemoryBytes"] = memory.total_bytes;
        response["freeMemoryBytes"] = memory.free_bytes;
        write_frame(response);
      } else if (type == "ping") {
        write_frame(success(request));
      } else if (type == "shutdown") {
        write_frame(success(request));
        break;
      } else {
        if (!index) {
          throw VectorGpuError("INVALID_FRAME", "hello must be sent first");
        }
        if (type == "snapshot.begin") {
          index->reset(request.header.value("dimensions", 0U),
                       request.header.value("total", 0U),
                       parse_precision(request.header));
          write_frame(success(request));
        } else if (type == "snapshot.batch") {
          require_precision(*index, request.header);
          const auto rows = parse_rows(request.header);
          index->append(rows, request.payload,
                        request.header.value("dimensions", 0U));
          write_frame(success(request));
        } else if (type == "snapshot.commit") {
          json response = success(request);
          response["vectors"] = index->active_count();
          response["deviceBytes"] = index->device_bytes();
          write_frame(response);
        } else if (type == "index.upsert") {
          require_precision(*index, request.header);
          const auto rows = parse_rows(request.header);
          index->upsert(parse_item(request.header.at("item")), rows,
                        request.payload,
                        request.header.value("dimensions", 0U));
          write_frame(success(request));
        } else if (type == "index.delete") {
          require_precision(*index, request.header);
          std::vector<ItemIdentity> items;
          for (const json& value : request.header.at("items")) {
            items.push_back(parse_item(value));
          }
          index->erase_items(items);
          write_frame(success(request));
        } else if (type == "index.clear") {
          require_precision(*index, request.header);
          if (request.header.value("all", false)) {
            index->clear_all();
          } else {
            index->clear_library(
                request.header.at("libraryID").get<std::int64_t>());
          }
          json response = success(request);
          response["vectors"] = index->active_count();
          response["deviceBytes"] = index->device_bytes();
          write_frame(response);
        } else if (type == "search") {
          require_precision(*index, request.header);
          SearchOptions options;
          options.top_k = request.header.value("topK", 10U);
          options.group_by_item = request.header.value("groupByItem", false);
          if (request.header.contains("documentLimit") &&
              !request.header["documentLimit"].is_null()) {
            options.document_limit =
                request.header["documentLimit"].get<std::size_t>();
          }
          options.max_chunks_per_item =
              request.header.value("maxChunksPerItem", 3U);
          options.language = request.header.value("language", "all");
          if (request.header.contains("itemKeys") &&
              request.header["itemKeys"].is_array()) {
            options.item_keys =
                request.header["itemKeys"].get<std::vector<std::string>>();
          }
          options.min_score = request.header.value("minScore", 0.0);
          options.library_id =
              request.header.at("libraryID").get<std::int64_t>();
          const auto result = index->search(request.payload, options);
          json response = success(request);
          response["scanned"] = result.scanned;
          response["gpuMs"] = result.gpu_ms;
          response["results"] = json::array();
          for (const auto& row : result.results) {
            response["results"].push_back(
                {{"libraryID", row.library_id},
                 {"itemKey", row.item_key},
                 {"chunkId", row.chunk_id},
                 {"score", row.score},
                 {"rowId", row.row_id},
                 {"language", row.language}});
          }
          write_frame(response);
        } else {
          throw VectorGpuError("INVALID_FRAME",
                               "Unknown command: " + type);
        }
      }
    } catch (const VectorGpuError& error) {
      if (request.header.is_object()) {
        write_error(request, error.code(), error.what());
      } else {
        std::cerr << error.code() << ": " << error.what() << std::endl;
        return 65;
      }
    } catch (const std::exception& error) {
      if (request.header.is_object()) {
        write_error(request, "INVALID_FRAME", error.what());
      } else {
        std::cerr << error.what() << std::endl;
        return 65;
      }
    }
  }
  return 0;
}
