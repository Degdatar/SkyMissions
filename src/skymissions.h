#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

#if defined(SKYOS_SKYMISSIONS_EXPORTS)
#define SKYOS_SKYMISSIONS_API __declspec(dllexport)
#else
#define SKYOS_SKYMISSIONS_API __declspec(dllimport)
#endif

namespace SkyOS {
    using SkyMissionsStoreIconRequestCallback = void(*)(std::uint32_t formID);

    [[nodiscard]] SKYOS_SKYMISSIONS_API std::string GetSkyMissionsPlayerUpdateScript();
    [[nodiscard]] SKYOS_SKYMISSIONS_API std::string GetSkyMissionsAssetsUpdateScript();
    [[nodiscard]] SKYOS_SKYMISSIONS_API std::string GetSkyMissionsStoreItemsUpdateScript();
    SKYOS_SKYMISSIONS_API void RequestSkyMissionsStoreItemIcons(SkyMissionsStoreIconRequestCallback callback);
    SKYOS_SKYMISSIONS_API void RequestSkyMissionsStoreItemIconsForForms(
        const std::uint32_t* formIDs, std::size_t count, SkyMissionsStoreIconRequestCallback callback);
    [[nodiscard]] SKYOS_SKYMISSIONS_API std::string GetSkyMissionsStoreItemIconUpdateScript(
        std::uint32_t formID, std::string_view iconUrl);
    [[nodiscard]] SKYOS_SKYMISSIONS_API bool QueueSkyMissionsStorePurchase(std::string_view offerId, std::uint32_t price);
    [[nodiscard]] SKYOS_SKYMISSIONS_API std::string GetSkyMissionsMissionNoticeScript(
        std::string_view missionTitle, std::uint32_t reward);
}
