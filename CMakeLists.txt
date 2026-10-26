cmake_minimum_required(VERSION 3.24)
project(SkyMissions VERSION 0.1.0 LANGUAGES CXX)

include(FetchContent)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Keep in sync with the CommonLibSSE-NG branch used by the SkyOS source tree.
FetchContent_Declare(
    CommonLibSSE
    GIT_REPOSITORY https://github.com/alandtse/CommonLibSSE-NG.git
    GIT_TAG ng
    GIT_SUBMODULES ""
    GIT_SHALLOW TRUE
)

set(BUILD_TESTS OFF CACHE BOOL "Disable CommonLibSSE-NG tests" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "Disable CommonLibSSE-NG tests" FORCE)
set(ENABLE_SKYRIM_VR OFF CACHE BOOL "SkyMissions supports Skyrim SE/AE, not VR" FORCE)

# CommonLib is a build dependency; do not copy its install rules into the mod package.
set(CMAKE_SKIP_INSTALL_RULES ON)
FetchContent_MakeAvailable(CommonLibSSE)
set(CMAKE_SKIP_INSTALL_RULES OFF)
include("${commonlibsse_SOURCE_DIR}/cmake/CommonLibSSE.cmake")

add_commonlibsse_plugin(SkyMissions
    NAME "SkyMissions"
    AUTHOR "SkyOS"
    VERSION ${PROJECT_VERSION}
    SOURCES
        src/skymissions.cpp
        src/app_module_entry.cpp
)

target_include_directories(SkyMissions PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${CMAKE_CURRENT_SOURCE_DIR}/data/SkyMissionsAPIHeader/include"
)
target_compile_features(SkyMissions PRIVATE cxx_std_23)
target_compile_definitions(SkyMissions PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    SKYOS_SKYMISSIONS_EXPORTS
)
target_precompile_headers(SkyMissions PRIVATE src/pch.h)

install(TARGETS SkyMissions RUNTIME DESTINATION "Data/SKSE/Plugins")

# SkyMissions owns the dashboard, notice overlay, player card, name cards,
# settings, and guides. The shared achievement rules remain SkyAchievements-owned.
install(DIRECTORY data/PrismaUI/views/SkyMissions
    DESTINATION "Data/PrismaUI/views")
install(DIRECTORY data/PrismaUI/views/SkyOS/SkyMissions
    DESTINATION "Data/PrismaUI/views/SkyOS")
install(DIRECTORY data/SKSE/Plugins/SkyOS/Mods/SkyMissions
    DESTINATION "Data/SKSE/Plugins/SkyOS/Mods")
install(DIRECTORY data/SKSE/Plugins/SkyOS/Mods/SkyViewer/SkyMissions
    DESTINATION "Data/SKSE/Plugins/SkyOS/Mods/SkyViewer")

# Ship the public mission and SkyStore API header with its branded guide.
install(FILES data/SkyMissionsAPIHeader/include/SkyMissionsAPI.h
    DESTINATION "Data/SKSE/Plugins/SkyMissionsAPIHeader/include")
install(FILES data/SkyMissionsAPIHeader/README.md
    DESTINATION "Data/SKSE/Plugins/SkyMissionsAPIHeader")
install(DIRECTORY data/SKSE/Plugins/SkyOS/Mods/SkyMissionsAPIHeader
    DESTINATION "Data/SKSE/Plugins/SkyOS/Mods")
install(FILES
    data/SKSE/Plugins/SkyOS/Mods/SkyMissions/logo.png
    data/SKSE/Plugins/SkyOS/Mods/SkyMissions/banner.png
    DESTINATION "Data/SKSE/Plugins/SkyOS/Mods/SkyMissionsAPIHeader")

set(CPACK_PACKAGE_NAME "SkyMissions")
set(CPACK_PACKAGE_VENDOR "SkyOS")
set(CPACK_PACKAGE_VERSION "${PROJECT_VERSION}")
set(CPACK_PACKAGE_FILE_NAME "SkyMissions-${PROJECT_VERSION}-SkyrimSE-AE")
set(CPACK_GENERATOR "ZIP")
include(CPack)
