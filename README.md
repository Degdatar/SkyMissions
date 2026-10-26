# SkyMissions

SkyMissions is a native SkyOS app module for character progress, randomized missions, SkyStore, player cards, and name cards. It exposes a versioned C ABI that lets other SKSE plugins register event-driven missions and store offers.

## Features

- Character dashboard for player information, completed missions, SkyPoints, achievements, name cards, and titles.
- Randomized mission offers that track supported SkyRewrite events and award SkyPoints when completed.
- SkyStore offers registered by native plugins; purchases are announced through the public API message contract.
- Configurable player card appearance and mission-completion notice style, position, size, and duration.
- Per-character mission progress, points, purchases, and card unlocks.

## Requirements

- Windows x64 and Visual Studio 2022 with the C++ desktop workload.
- CMake 3.24 or newer.
- Git, for fetching CommonLibSSE-NG.
- vcpkg with `VCPKG_ROOT` set and the `x64-windows-static-md` triplet.
- Skyrim Special Edition / Anniversary Edition, SKSE, PrismaUI, and the matching SkyOS core at runtime.
- SkyRewrite is required for gameplay-event missions.
- SkyAchievements is required for the shared achievement rules used by the dashboard. The shared `achievement-rules.js` remains owned and installed by SkyAchievements.
- SkyCollection is optional; it provides additional save-backed discovery information.

## Build and package

Configure and build the Release preset from this directory:

```powershell
cmake --preset release
cmake --build --preset release --parallel
```

Create a 7-Zip archive from CPack's install manifest:

```powershell
cpack --config build/CPackConfig.cmake -G 7Z -C Release
```

The package contains `SkyMissions.dll`, the dashboard and notice views, player card and name card artwork, SkyViewer settings, SkyDocuments, and the public API header and guide under Skyrim's `Data` layout. Install SkyOS Core, SkyRewrite, SkyAchievements, SKSE, and PrismaUI in the profile as required runtime dependencies. CPack's 7Z generator must be available on the machine.

## SkyOS integration

`SkyOS.dll` owns the shared shell and loads `SkyMissions.dll` as an app module. SkyMissions provides its own dashboard, mission and store logic, save serialization, and native mission/purchase APIs. Its entry checks for the core and SkyRewrite at data load and remains inactive if either is missing.

The dashboard imports the shared achievement rules from SkyAchievements. Install SkyAchievements alongside this project; the rule file is intentionally kept with its owner. SkyCollection remains an optional integration.

## Public API

The public header is `data/SkyMissionsAPIHeader/include/SkyMissionsAPI.h`. It provides mission and SkyStore registration functions and the purchase-message contract through a versioned C ABI. See `data/SKSE/Plugins/SkyOS/Mods/SkyMissionsAPIHeader/SkyDocuments/SkyMissions API Guide.html` for usage examples.

Mission definitions match SkyRewrite journal events. Mod authors who register event-type filters should also include `SkyRewriteAPI.h` from the SkyRewrite API Header package for named event constants. The SkyMissions API guide explains this dependency.

## SkyDocuments

The SkyMissions module guide and feature reference are in `data/SKSE/Plugins/SkyOS/Mods/SkyMissions/SkyDocuments/`. The API guide is in `data/SKSE/Plugins/SkyOS/Mods/SkyMissionsAPIHeader/SkyDocuments/`.

## Repository layout

```text
src/                                                        Native SKSE plugin, module entry, and mission/store implementation
data/PrismaUI/views/SkyMissions/                             SkyMissions dashboard and app-owned logo, banner, and SkyPoints logo
data/PrismaUI/views/SkyOS/SkyMissions/                       Mission-completion notice view
data/SKSE/Plugins/SkyOS/Mods/SkyMissions/                    App metadata, player card, name cards, and SkyDocuments
data/SKSE/Plugins/SkyOS/Mods/SkyViewer/SkyMissions/          SkyViewer settings module and its page assets
data/SkyMissionsAPIHeader/                                   Public C ABI header and README
data/SKSE/Plugins/SkyOS/Mods/SkyMissionsAPIHeader/           Branded API SkyDocuments guide
```

Mission progress, SkyPoints, purchased offers, player details, and unlocked cards are serialized per character in the active save's SKSE co-save. Module settings are stored by SkyViewer; dashboard preferences are stored locally by the page.
