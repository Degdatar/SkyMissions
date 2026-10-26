# SkyMissions API

SkyMissions exposes a versioned C ABI for SKSE plugins that register custom missions and SkyStore offers. The API header and branded guide are included in this standalone project and installed with the SkyMissions package.

## Contents

- `include/SkyMissionsAPI.h` — mission and offer structures, dynamic `GetProcAddress` loader, and SkyStore purchase message contract.
- `Data/SKSE/Plugins/SkyOS/Mods/SkyMissionsAPIHeader/SkyDocuments/SkyMissions API Guide.html` — branded API guide with registration and purchase examples.
- `Data/SKSE/Plugins/SkyOS/Mods/SkyMissionsAPIHeader/logo.png` and `banner.png` — guide artwork.

## Quick start

Install SkyOS Core, SkyMissions, and SkyRewrite. Include `SkyMissionsAPI.h` in your SKSE plugin. During plugin initialization, resolve the already-loaded `SkyMissions.dll` with `GetModuleHandleW`, call `SkyMissions_LoadAPI`, then register missions and offers. Repeated registrations with the same owner and ID update that definition.

Mission definitions are matched against SkyRewrite journal event types and optional FormID, base FormID, subject, and identity filters. Players accept them in SkyMissions; progress and rewards are stored per character. Store purchases deduct SkyPoints and are broadcast through the SKSE messaging interface using `SKYMISSIONS_STORE_PURCHASE_MESSAGE` and `SkyMissionsStorePurchaseV1`. The owning plugin is responsible for delivering the purchased feature or item.

Registration functions return `1` for a new entry, `2` for a replacement, and `0` when validation or capacity checks reject it. Register during plugin initialization so the definitions are present when the player opens SkyMissions.

Plugins that use named SkyRewrite journal event constants should also include `SkyRewriteAPI.h` from the separate SkyRewrite API Header package. Raw event type values can be used without that header.
