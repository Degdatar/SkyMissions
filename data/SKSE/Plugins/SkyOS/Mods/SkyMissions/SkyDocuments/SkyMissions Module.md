# SkyMissions

SkyMissions is an optional SkyOS app module. It requires **SkyOS.dll** and **SkyRewrite.dll** for gameplay-event mission tracking. SkyCollection remains an optional integration. SkyOS Core itself does not require SkyRewrite.

## Tabs

- **Dashboard** shows the active character, name card, player card, latest ten SkyRewrite actions, unlocked achievements, SkyPoints owned, and basic information. Its subtabs are **Overview**, **Factions**, **Properties**, **Name Cards**, and **Titles**.
- **SkyMissions** keeps twelve randomized offers visible in a four-column, three-row desktop grid. Accept an offer to track it; after completing one, that offer is replaced. Mission progress comes from supported gameplay events, not Skyrim quest objectives. Offers can target hostile groups individually (including Afflicted, bandits, Forsworn, ghosts, Reavers, warlock mage types, Penitus Oculatus, vampires, witches, and hostile creatures), require a named ingredient, request potion crafting or a particular potion, require smithing in general or a named item, or ask for pelts and hides. Enemy-specific offers count hostile kills; ingredient offers count item pickups or looting; crafting offers count SkyRewrite potion-crafted or item-smithed records.
- **SkyStore** lets a player spend SkyPoints on rotating game items, purchasable name cards, offers declared by installed SkyOS module manifests, and offers registered by native plugins through the SkyMissions API.

Mission progress, completed count, SkyPoints, accepted offers, purchased offers, and name-card unlocks are stored per character in SkyMissions browser storage. The Dashboard's Actions list shows at most the newest ten events delivered by SkyRewrite.

## Player card and name card artwork

Put the active portrait at `Data/SKSE/Plugins/SkyOS/Mods/SkyMissions/Player Card/Player Card.png` (or JPG/GIF if selected in SkyViewer). The card is contained in the dashboard frame. Put name-card art in `Data/SKSE/Plugins/SkyOS/Mods/SkyMissions/Name Cards/`. `Default Name Card.png` is unlocked by default. The first ten other cards unlock by completed missions; later cards use SkyPoints.

## Mission-completion notice

SkyViewer → SkyMissions contains a show/hide switch, three distinct notice designs, and all nine screen positions. The notice reports the mission name and SkyPoints reward.

## Contributing to SkyStore

A module may declare `skyStoreOffers` in its SkyViewer `module.json`. SkyMissions validates and displays up to 100 entries from each module. Each offer uses a stable unique `id`, `name`, non-negative integer `price`, and optional `description` and `image` fields:

```json
{
  "skyStoreOffers": [
    {
      "id": "example-feature",
      "name": "Example Feature",
      "description": "A feature supplied by ExampleMod.",
      "price": 750,
      "image": ""
    }
  ]
}
```

SkyMissions records the purchase as a per-character entitlement and notifies the SkyOS host with the originating module ID, offer ID, display name, and price. The module author remains responsible for granting the purchased app feature.

## Native mission and SkyStore API

The standalone SkyMissions project ships `SkyMissionsAPI.h` and its guide with the app. Plugins that use named SkyRewrite journal event constants also need `SkyRewriteAPI.h` from the separate SkyRewrite API Header package. An SKSE plugin can register up to 64 missions and 256 SkyStore offers during plugin initialization. Missions match SkyRewrite journal event types and optional FormID, base FormID, subject, and identity filters; players accept them in SkyMissions and receive the configured SkyPoints reward when they complete. Store purchases are broadcast with the `SMPS` message and the public `SkyMissionsStorePurchaseV1` payload so the owning plugin can fulfill its item or feature. The API guide documents the C ABI and message contract.

