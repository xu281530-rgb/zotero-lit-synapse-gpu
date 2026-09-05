#include "vector_index.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <cstring>
#include <numeric>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace zotero_gpu {
namespace {

constexpr double kScoreRankingPrecision = 1e12;

double ranking_score(double score) {
  return std::round(score * kScoreRankingPrecision) / kScoreRankingPrecision;
}

bool score_less(double left, double right) {
  return ranking_score(left) < ranking_score(right);
}

bool score_greater(double left, double right) {
  return ranking_score(left) > ranking_score(right);
}

bool ranks_before(const SearchResult& left, const SearchResult& right) {
  return score_greater(left.score, right.score);
}

bool ranks_after(const SearchResult& left, const SearchResult& right) {
  return score_less(left.score, right.score);
}

[[noreturn]] void throw_cuda(cudaError_t status, const char* operation) {
  std::string code = "UNKNOWN";
  if (status == cudaErrorNoDevice) code = "NO_CUDA_DEVICE";
  if (status == cudaErrorInsufficientDriver) code = "DRIVER_INCOMPATIBLE";
  if (status == cudaErrorMemoryAllocation) code = "OUT_OF_MEMORY";
  throw VectorGpuError(code, std::string(operation) + ": " +
                                 cudaGetErrorString(status));
}

void check_cuda(cudaError_t status, const char* operation) {
  if (status != cudaSuccess) throw_cuda(status, operation);
}

__global__ void cosine_int8_kernel(const std::int8_t* vectors,
                                   const double* norms_squared,
                                   const std::int8_t* query,
                                   double query_norm_squared,
                                   double* scores,
                                   std::size_t rows,
                                   std::size_t dimensions) {
  const std::size_t row =
      static_cast<std::size_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  if (row >= rows) return;
  const std::int8_t* vector = vectors + row * dimensions;
  int dot = 0;
  for (std::size_t column = 0; column < dimensions; ++column) {
    dot += static_cast<int>(query[column]) * static_cast<int>(vector[column]);
  }
  const double denominator =
      sqrt(query_norm_squared * norms_squared[row]);
  scores[row] = denominator > 0.0 ? static_cast<double>(dot) / denominator : 0.0;
}

__global__ void cosine_float32_kernel(const float* vectors,
                                      const double* norms_squared,
                                      const float* query,
                                      double query_norm_squared,
                                      double* scores,
                                      std::size_t rows,
                                      std::size_t dimensions) {
  const std::size_t row =
      static_cast<std::size_t>(blockIdx.x) * blockDim.x + threadIdx.x;
  if (row >= rows) return;
  const float* vector = vectors + row * dimensions;
  float dot = 0.0F;
  for (std::size_t column = 0; column < dimensions; ++column) {
    dot += query[column] * vector[column];
  }
  const double denominator = sqrt(query_norm_squared * norms_squared[row]);
  scores[row] = denominator > 0.0 ? static_cast<double>(dot) / denominator : 0.0;
}

std::string item_token(std::int64_t library_id, const std::string& item_key) {
  return std::to_string(library_id) + ":" + item_key;
}

}  // namespace

struct VectorIndex::Impl {
  struct Slot {
    bool active = false;
    IncomingRow row;
  };

  std::string device_name;
  std::size_t dimensions = 0;
  std::size_t capacity = 0;
  std::size_t active = 0;
  VectorPrecision precision = VectorPrecision::Int8;
  void* device_vectors = nullptr;
  void* device_query = nullptr;
  double* device_norms = nullptr;
  double* device_scores = nullptr;
  std::vector<Slot> slots;
  std::vector<std::size_t> free_slots;
  std::unordered_map<std::string, std::vector<std::size_t>> item_slots;

  Impl() {
    int count = 0;
    check_cuda(cudaGetDeviceCount(&count), "cudaGetDeviceCount");
    if (count <= 0) {
      throw VectorGpuError("NO_CUDA_DEVICE", "No NVIDIA CUDA device detected");
    }
    check_cuda(cudaSetDevice(0), "cudaSetDevice");
    cudaDeviceProp properties{};
    check_cuda(cudaGetDeviceProperties(&properties, 0),
               "cudaGetDeviceProperties");
    device_name = properties.name;
  }

  ~Impl() { release(); }

  void release() {
    if (device_vectors) cudaFree(device_vectors);
    if (device_query) cudaFree(device_query);
    if (device_norms) cudaFree(device_norms);
    if (device_scores) cudaFree(device_scores);
    device_vectors = nullptr;
    device_query = nullptr;
    device_norms = nullptr;
    device_scores = nullptr;
    capacity = 0;
  }

  std::size_t element_bytes() const {
    return precision == VectorPrecision::Float32 ? sizeof(float)
                                                 : sizeof(std::int8_t);
  }

  std::size_t vector_bytes(std::size_t rows) const {
    return rows * dimensions * element_bytes();
  }

  void reset(std::size_t new_dimensions, std::size_t expected_rows,
             VectorPrecision new_precision) {
    release();
    dimensions = new_dimensions;
    precision = new_precision;
    active = 0;
    slots.clear();
    free_slots.clear();
    item_slots.clear();
    if (dimensions == 0 || expected_rows == 0) return;
    const std::size_t growth_capacity = expected_rows + expected_rows / 4 +
                                        (expected_rows % 4 == 0 ? 0 : 1);
    allocate(std::max<std::size_t>(growth_capacity, 1024));
  }

  void allocate(std::size_t new_capacity) {
    if (dimensions == 0 || new_capacity == 0) return;
    void* new_vectors = nullptr;
    double* new_norms = nullptr;
    double* new_scores = nullptr;
    check_cuda(cudaMalloc(&new_vectors, vector_bytes(new_capacity)),
               "cudaMalloc vectors");
    try {
      check_cuda(cudaMalloc(&new_norms, new_capacity * sizeof(double)),
                 "cudaMalloc norms");
      check_cuda(cudaMalloc(&new_scores, new_capacity * sizeof(double)),
                 "cudaMalloc scores");
      if (device_vectors && !slots.empty()) {
        check_cuda(cudaMemcpy(new_vectors, device_vectors,
                              vector_bytes(slots.size()),
                              cudaMemcpyDeviceToDevice),
                   "cudaMemcpy grow vectors");
        check_cuda(cudaMemcpy(new_norms, device_norms,
                              slots.size() * sizeof(double),
                              cudaMemcpyDeviceToDevice),
                   "cudaMemcpy grow norms");
      }
    } catch (...) {
      if (new_vectors) cudaFree(new_vectors);
      if (new_norms) cudaFree(new_norms);
      if (new_scores) cudaFree(new_scores);
      throw;
    }
    if (device_vectors) cudaFree(device_vectors);
    if (device_norms) cudaFree(device_norms);
    if (device_scores) cudaFree(device_scores);
    device_vectors = new_vectors;
    device_norms = new_norms;
    device_scores = new_scores;
    capacity = new_capacity;
    if (!device_query) {
      check_cuda(cudaMalloc(&device_query, dimensions * element_bytes()),
                 "cudaMalloc query");
    }
  }

  void ensure_capacity(std::size_t additions) {
    const std::size_t reusable = free_slots.size();
    const std::size_t required =
        slots.size() + (additions > reusable ? additions - reusable : 0);
    if (required <= capacity) return;
    std::size_t next = std::max<std::size_t>(capacity, 1024);
    while (next < required) next *= 2;
    allocate(next);
  }

  std::size_t acquire_slot() {
    if (!free_slots.empty()) {
      const std::size_t slot = free_slots.back();
      free_slots.pop_back();
      return slot;
    }
    slots.push_back({});
    return slots.size() - 1;
  }

  void remove_item(const ItemIdentity& item) {
    const std::string token = item_token(item.library_id, item.item_key);
    const auto found = item_slots.find(token);
    if (found == item_slots.end()) return;
    for (const std::size_t slot : found->second) {
      if (!slots[slot].active) continue;
      slots[slot].active = false;
      free_slots.push_back(slot);
      --active;
    }
    item_slots.erase(found);
  }

  void append_rows(const std::vector<IncomingRow>& rows,
                   const std::vector<std::uint8_t>& vectors,
                   std::size_t incoming_dimensions) {
    if (rows.empty()) return;
    if (dimensions == 0) dimensions = incoming_dimensions;
    if (incoming_dimensions != dimensions ||
        vectors.size() != rows.size() * dimensions * element_bytes()) {
      throw VectorGpuError("DIMENSION_MISMATCH",
                           "GPU index vector dimensions do not match");
    }
    ensure_capacity(rows.size());
    for (std::size_t index = 0; index < rows.size(); ++index) {
      double norm_squared = 0.0;
      const std::uint8_t* vector =
          vectors.data() + index * dimensions * element_bytes();
      for (std::size_t column = 0; column < dimensions; ++column) {
        double value = 0.0;
        if (precision == VectorPrecision::Float32) {
          float float_value = 0.0F;
          std::memcpy(&float_value, vector + column * sizeof(float),
                      sizeof(float));
          value = static_cast<double>(float_value);
        } else {
          value = static_cast<double>(
              static_cast<std::int8_t>(vector[column]));
        }
        norm_squared += value * value;
      }
      const std::size_t slot = acquire_slot();
      slots[slot] = {true, rows[index]};
      item_slots[item_token(rows[index].library_id, rows[index].item_key)]
          .push_back(slot);
      check_cuda(cudaMemcpy(static_cast<std::uint8_t*>(device_vectors) +
                                slot * dimensions * element_bytes(),
                            vector, dimensions * element_bytes(),
                            cudaMemcpyHostToDevice),
                 "cudaMemcpy vector upload");
      check_cuda(cudaMemcpy(device_norms + slot, &norm_squared,
                            sizeof(double), cudaMemcpyHostToDevice),
                 "cudaMemcpy norm upload");
      ++active;
    }
  }

  void maybe_compact() {
    if (slots.size() < 1024 || free_slots.size() * 4 < slots.size()) return;
    const std::size_t new_capacity =
        std::max<std::size_t>(1024, active + active / 4 + 1);
    void* old_vectors = device_vectors;
    double* old_norms = device_norms;
    double* old_scores = device_scores;
    const std::size_t old_capacity = capacity;
    device_vectors = nullptr;
    device_norms = nullptr;
    device_scores = nullptr;
    capacity = 0;
    allocate(new_capacity);

    std::vector<Slot> compacted;
    compacted.reserve(active);
    item_slots.clear();
    for (std::size_t old_slot = 0; old_slot < slots.size(); ++old_slot) {
      if (!slots[old_slot].active) continue;
      const std::size_t new_slot = compacted.size();
      compacted.push_back(slots[old_slot]);
      check_cuda(cudaMemcpy(
                            static_cast<std::uint8_t*>(device_vectors) +
                                new_slot * dimensions * element_bytes(),
                            static_cast<std::uint8_t*>(old_vectors) +
                                old_slot * dimensions * element_bytes(),
                            dimensions * element_bytes(),
                            cudaMemcpyDeviceToDevice),
                 "cudaMemcpy compact vector");
      check_cuda(cudaMemcpy(device_norms + new_slot, old_norms + old_slot,
                            sizeof(double), cudaMemcpyDeviceToDevice),
                 "cudaMemcpy compact norm");
      const IncomingRow& row = compacted.back().row;
      item_slots[item_token(row.library_id, row.item_key)].push_back(new_slot);
    }
    slots.swap(compacted);
    free_slots.clear();
    if (old_vectors) cudaFree(old_vectors);
    if (old_norms) cudaFree(old_norms);
    if (old_scores) cudaFree(old_scores);
    (void)old_capacity;
  }
};

VectorIndex::VectorIndex() : impl_(std::make_unique<Impl>()) {}
VectorIndex::~VectorIndex() = default;

const std::string& VectorIndex::device_name() const {
  return impl_->device_name;
}

DeviceMemoryInfo VectorIndex::memory_info() const {
  DeviceMemoryInfo info;
  check_cuda(cudaMemGetInfo(&info.free_bytes, &info.total_bytes),
             "cudaMemGetInfo");
  return info;
}

void VectorIndex::reset(std::size_t dimensions, std::size_t expected_rows,
                        VectorPrecision precision) {
  impl_->reset(dimensions, expected_rows, precision);
}

void VectorIndex::append(const std::vector<IncomingRow>& rows,
                         const std::vector<std::uint8_t>& vectors,
                         std::size_t dimensions) {
  impl_->append_rows(rows, vectors, dimensions);
}

void VectorIndex::upsert(const ItemIdentity& item,
                         const std::vector<IncomingRow>& rows,
                         const std::vector<std::uint8_t>& vectors,
                         std::size_t dimensions) {
  impl_->remove_item(item);
  impl_->append_rows(rows, vectors, dimensions);
}

void VectorIndex::erase_items(const std::vector<ItemIdentity>& items) {
  for (const ItemIdentity& item : items) impl_->remove_item(item);
  impl_->maybe_compact();
}

void VectorIndex::clear_library(std::int64_t library_id) {
  std::vector<ItemIdentity> items;
  items.reserve(impl_->item_slots.size());
  for (const auto& [token, slots] : impl_->item_slots) {
    if (!slots.empty() && impl_->slots[slots.front()].row.library_id == library_id) {
      const IncomingRow& row = impl_->slots[slots.front()].row;
      items.push_back({row.library_id, row.item_key});
    }
  }
  erase_items(items);
}

void VectorIndex::clear_all() { impl_->reset(0, 0, impl_->precision); }

SearchResponse VectorIndex::search(const std::vector<std::uint8_t>& query,
                                   const SearchOptions& options) {
  if (impl_->active == 0) return {};
  if (query.size() != impl_->dimensions * impl_->element_bytes()) {
    throw VectorGpuError("DIMENSION_MISMATCH",
                         "Query dimensions do not match the GPU index");
  }

  double query_norm_squared = 0.0;
  for (std::size_t column = 0; column < impl_->dimensions; ++column) {
    double value = 0.0;
    if (impl_->precision == VectorPrecision::Float32) {
      float float_value = 0.0F;
      std::memcpy(&float_value, query.data() + column * sizeof(float),
                  sizeof(float));
      value = static_cast<double>(float_value);
    } else {
      value = static_cast<double>(
          static_cast<std::int8_t>(query[column]));
    }
    query_norm_squared += value * value;
  }
  if (!(query_norm_squared > 0.0)) return {};
  check_cuda(cudaMemcpy(impl_->device_query, query.data(), query.size(),
                        cudaMemcpyHostToDevice),
             "cudaMemcpy query");
  const auto started = std::chrono::steady_clock::now();
  constexpr int block_size = 256;
  const int blocks = static_cast<int>(
      (impl_->slots.size() + block_size - 1) / block_size);
  if (impl_->precision == VectorPrecision::Float32) {
    cosine_float32_kernel<<<blocks, block_size>>>(
        static_cast<const float*>(impl_->device_vectors), impl_->device_norms,
        static_cast<const float*>(impl_->device_query), query_norm_squared,
        impl_->device_scores, impl_->slots.size(), impl_->dimensions);
    check_cuda(cudaGetLastError(), "cosine_float32_kernel launch");
    check_cuda(cudaDeviceSynchronize(), "cosine_float32_kernel synchronize");
  } else {
    cosine_int8_kernel<<<blocks, block_size>>>(
        static_cast<const std::int8_t*>(impl_->device_vectors),
        impl_->device_norms,
        static_cast<const std::int8_t*>(impl_->device_query),
        query_norm_squared, impl_->device_scores, impl_->slots.size(),
        impl_->dimensions);
    check_cuda(cudaGetLastError(), "cosine_int8_kernel launch");
    check_cuda(cudaDeviceSynchronize(), "cosine_int8_kernel synchronize");
  }
  const auto completed = std::chrono::steady_clock::now();

  std::vector<double> scores(impl_->slots.size());
  check_cuda(cudaMemcpy(scores.data(), impl_->device_scores,
                        scores.size() * sizeof(double), cudaMemcpyDeviceToHost),
             "cudaMemcpy scores");

  std::vector<std::size_t> order;
  order.reserve(impl_->active);
  for (std::size_t slot = 0; slot < impl_->slots.size(); ++slot) {
    if (impl_->slots[slot].active) order.push_back(slot);
  }
  std::sort(order.begin(), order.end(), [&](std::size_t left, std::size_t right) {
    return impl_->slots[left].row.row_id < impl_->slots[right].row.row_id;
  });

  std::optional<std::unordered_set<std::string>> item_filter;
  if (options.item_keys) {
    item_filter.emplace(options.item_keys->begin(), options.item_keys->end());
  }
  std::vector<SearchResult> candidates;
  candidates.reserve(order.size());
  SearchResponse response;
  response.gpu_ms =
      std::chrono::duration<double, std::milli>(completed - started).count();
  for (const std::size_t slot : order) {
    const IncomingRow& row = impl_->slots[slot].row;
    if (options.library_id && row.library_id != *options.library_id) continue;
    if (options.language != "all" && row.language != options.language) continue;
    if (item_filter && item_filter->find(row.item_key) == item_filter->end()) {
      continue;
    }
    ++response.scanned;
    if (scores[slot] < options.min_score || std::isnan(scores[slot])) continue;
    candidates.push_back({row.row_id, row.library_id, row.item_key,
                          row.chunk_id, row.language, scores[slot]});
  }

  if (options.group_by_item) {
    std::unordered_map<std::string, std::vector<SearchResult>> documents;
    for (const SearchResult& result : candidates) {
      auto& chunks =
          documents[item_token(result.library_id, result.item_key)];
      chunks.push_back(result);
      std::stable_sort(chunks.begin(), chunks.end(),
                       [](const SearchResult& left, const SearchResult& right) {
                         return ranks_before(left, right);
                       });
      if (chunks.size() > options.max_chunks_per_item) {
        chunks.resize(options.max_chunks_per_item);
      }
    }
    std::vector<std::pair<std::string, std::vector<SearchResult>>> ranked;
    ranked.reserve(documents.size());
    for (auto& entry : documents) ranked.push_back(std::move(entry));
    std::sort(ranked.begin(), ranked.end(), [](const auto& left, const auto& right) {
      const double left_score = left.second.front().score;
      const double right_score = right.second.front().score;
      return score_greater(left_score, right_score)
                 ? true
                 : score_greater(right_score, left_score)
                       ? false
                       : left.first < right.first;
    });
    if (options.document_limit && ranked.size() > *options.document_limit) {
      ranked.resize(*options.document_limit);
    }
    for (auto& [token, chunks] : ranked) {
      response.results.insert(response.results.end(), chunks.begin(), chunks.end());
    }
    return response;
  }

  std::vector<SearchResult> heap;
  heap.reserve(options.top_k);
  auto sift_up = [&heap](std::size_t index) {
    while (index > 0) {
      const std::size_t parent = (index - 1) >> 1;
      if (!ranks_after(heap[index], heap[parent])) break;
      std::swap(heap[parent], heap[index]);
      index = parent;
    }
  };
  auto sift_down = [&heap]() {
    std::size_t index = 0;
    for (;;) {
      const std::size_t left = index * 2 + 1;
      const std::size_t right = left + 1;
      std::size_t smallest = index;
      if (left < heap.size() && ranks_after(heap[left], heap[smallest])) {
        smallest = left;
      }
      if (right < heap.size() && ranks_after(heap[right], heap[smallest])) {
        smallest = right;
      }
      if (smallest == index) break;
      std::swap(heap[index], heap[smallest]);
      index = smallest;
    }
  };
  for (const SearchResult& result : candidates) {
    if (options.top_k == 0) break;
    if (heap.size() < options.top_k) {
      heap.push_back(result);
      sift_up(heap.size() - 1);
    } else if (ranks_before(result, heap.front())) {
      heap.front() = result;
      sift_down();
    }
  }
  std::stable_sort(heap.begin(), heap.end(),
                   [](const SearchResult& left, const SearchResult& right) {
                     return ranks_before(left, right);
                   });
  response.results = std::move(heap);
  return response;
}

std::size_t VectorIndex::active_count() const { return impl_->active; }
std::size_t VectorIndex::device_bytes() const {
  return impl_->capacity *
             (impl_->dimensions * impl_->element_bytes() + 2 * sizeof(double)) +
         impl_->dimensions * impl_->element_bytes();
}
std::size_t VectorIndex::dimensions() const { return impl_->dimensions; }
VectorPrecision VectorIndex::precision() const { return impl_->precision; }

}  // namespace zotero_gpu
