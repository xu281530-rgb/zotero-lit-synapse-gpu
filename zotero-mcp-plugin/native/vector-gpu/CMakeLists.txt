cmake_minimum_required(VERSION 3.27)

project(zotero_vector_gpu VERSION 1.0.0 LANGUAGES CXX CUDA)

if(NOT WIN32 OR NOT MSVC)
  message(FATAL_ERROR "vector-gpu is supported only with MSVC on Windows x64")
endif()

find_package(CUDAToolkit 12.6 REQUIRED)

add_executable(vector-gpu
  src/main.cpp
  src/vector_index.cu
)

target_include_directories(vector-gpu PRIVATE
  include
  third_party
)

target_compile_features(vector-gpu PRIVATE cxx_std_20 cuda_std_17)
target_compile_definitions(vector-gpu PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
)
target_compile_options(vector-gpu PRIVATE
  $<$<COMPILE_LANGUAGE:CXX>:/W4 /permissive->
  $<$<COMPILE_LANGUAGE:CUDA>:-Xcompiler=/W4>
)
target_link_libraries(vector-gpu PRIVATE CUDA::cudart)

set_target_properties(vector-gpu PROPERTIES
  CUDA_ARCHITECTURES "75;80;86;89"
  CUDA_RUNTIME_LIBRARY Shared
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)
