#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace zotero_gpu {

class VectorGpuError : public std::runtime_error {
 public:
  VectorGpuError(std::string code, const std::string& message)
      : std::runtime_error(message), code_(std::move(code)) {}

  const std::string& code() const noexcept { return code_; }

 private:
  std::string code_;
};

struct ItemIdentity {
  std::int64_t library_id = 0;
  std::string item_key;
};

struct IncomingRow {
  std::int64_t row_id = 0;
  std::int64_t library_id = 0;
  std::string item_key;
  std::int32_t chunk_id = 0;
  std::string language;
  double norm = 0.0;
};

struct SearchOptions {
  std::size_t top_k = 10;
  bool group_by_item = false;
  std::optional<std::size_t> document_limit;
  std::size_t max_chunks_per_item = 3;
  std::string language = "all";
  std::optional<std::vector<std::string>> item_keys;
  double min_score = 0.0;
  std::int64_t library_id = 0;
};

struct SearchResult {
  std::int64_t row_id = 0;
  std::int64_t library_id = 0;
  std::string item_key;
  std::int32_t chunk_id = 0;
  std::string language;
  double score = 0.0;
};

struct SearchResponse {
  std::vector<SearchResult> results;
  std::size_t scanned = 0;
  double gpu_ms = 0.0;
};

class VectorIndex {
 public:
  VectorIndex();
  ~VectorIndex();
  VectorIndex(const VectorIndex&) = delete;
  VectorIndex& operator=(const VectorIndex&) = delete;

  const std::string& device_name() const;
  void reset(std::size_t dimensions, std::size_t expected_rows);
  void append(const std::vector<IncomingRow>& rows,
              const std::vector<std::int8_t>& vectors,
              std::size_t dimensions);
  void upsert(const ItemIdentity& item,
              const std::vector<IncomingRow>& rows,
              const std::vector<std::int8_t>& vectors,
              std::size_t dimensions);
  void erase_items(const std::vector<ItemIdentity>& items);
  void clear_library(std::int64_t library_id);
  void clear_all();
  SearchResponse search(const std::vector<std::int8_t>& query,
                        double query_norm,
                        const SearchOptions& options);

  std::size_t active_count() const;
  std::size_t device_bytes() const;
  std::size_t dimensions() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace zotero_gpu
