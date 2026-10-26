#include "skymissions.h"

#include <RE/A/Actor.h>
#include <RE/A/ActorValues.h>
#include <RE/P/PlayerCharacter.h>
#include <RE/T/TESDataHandler.h>
#include <RE/T/TESFaction.h>
#include <RE/T/TESFile.h>
#include <RE/T/TESNPC.h>
#include <RE/T/TESObjectARMO.h>
#include <RE/T/TESObjectCELL.h>
#include <RE/T/TESObjectWEAP.h>
#include <RE/T/TESSoulGem.h>

// Keep Windows.h after CommonLib's RE headers so its interlocked-operation
// macros cannot rewrite REX::W32 declarations used by those headers.
#include <Windows.h>
#include <SkyMissionsAPI.h>

#include <algorithm>
#include <array>
#include <charconv>
#include <cctype>
#include <chrono>
#include <cstring>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <mutex>
#include <numeric>
#include <random>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

namespace fs = std::filesystem;

namespace {
    std::string JsString(std::string_view text);

    struct StoreCandidate
    {
        RE::FormID formID{};
        std::string name;
        std::string category;
        std::string description;
        std::string plugin;
        std::uint32_t localFormID{};
    };

    constexpr std::size_t kStoreCandidateCacheLimit = 4096;
    constexpr std::size_t kRandomStoreItemLimit = 10;
    std::vector<StoreCandidate> g_storeCandidates;
    bool g_storeCandidatesLoaded{};
    std::mt19937_64 g_storeRng{ static_cast<std::uint64_t>(std::chrono::steady_clock::now().time_since_epoch().count()) };
    std::uint64_t g_storeGeneration{ static_cast<std::uint64_t>(std::chrono::steady_clock::now().time_since_epoch().count()) };
    std::mutex g_storeStockMutex;
    std::vector<RE::FormID> g_currentStoreFormIDs;

    struct RegisteredMission
    {
        std::string ownerId;
        std::string id;
        std::string title;
        std::string description;
        std::string subjectContains;
        std::string identityContains;
        std::uint32_t eventType{};
        std::uint32_t goal{};
        std::uint32_t reward{};
        std::uint32_t formID{};
        std::uint32_t baseFormID{};
    };

    struct RegisteredStoreOffer
    {
        std::string ownerId;
        std::string id;
        std::string name;
        std::string description;
        std::string image;
        std::uint32_t price{};
    };

    std::mutex g_publicApiMutex;
    std::vector<RegisteredMission> g_registeredMissions;
    std::vector<RegisteredStoreOffer> g_registeredStoreOffers;

    bool CopyApiText(const char* value, std::size_t capacity, std::size_t maxLength, std::string& output,
        bool required = false)
    {
        if (!value || capacity == 0) return false;
        const auto* end = static_cast<const char*>(std::memchr(value, '\0', capacity));
        if (!end) return false;
        const auto length = static_cast<std::size_t>(end - value);
        if (length > maxLength || (required && length == 0)) return false;
        for (std::size_t index = 0; index < length; ++index) {
            const auto ch = static_cast<unsigned char>(value[index]);
            if (ch < 0x20 || ch == 0x7F) return false;
        }
        output.assign(value, length);
        return true;
    }

    bool IsApiIdentifier(std::string_view value)
    {
        if (value.empty()) return false;
        return std::all_of(value.begin(), value.end(), [](unsigned char ch) {
            return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
                (ch >= '0' && ch <= '9') || ch == '_' || ch == '-' || ch == '.';
        });
    }

    bool CopyApiIdentity(const char* value, std::size_t capacity, std::string& output)
    {
        return CopyApiText(value, capacity, capacity - 1, output, true) && IsApiIdentifier(output);
    }

    std::string RegisteredMissionsJson()
    {
        std::vector<RegisteredMission> snapshot;
        {
            std::scoped_lock lock(g_publicApiMutex);
            snapshot = g_registeredMissions;
        }
        std::string json = "[";
        for (std::size_t index = 0; index < snapshot.size(); ++index) {
            if (index) json += ',';
            const auto& mission = snapshot[index];
            json += "{\"ownerId\":" + JsString(mission.ownerId) + ",\"id\":" + JsString(mission.id) +
                ",\"title\":" + JsString(mission.title) + ",\"description\":" + JsString(mission.description) +
                ",\"eventType\":" + std::to_string(mission.eventType) + ",\"goal\":" + std::to_string(mission.goal) +
                ",\"reward\":" + std::to_string(mission.reward) + ",\"formID\":" + std::to_string(mission.formID) +
                ",\"baseFormID\":" + std::to_string(mission.baseFormID) +
                ",\"subjectContains\":" + JsString(mission.subjectContains) +
                ",\"identityContains\":" + JsString(mission.identityContains) + "}";
        }
        return json + "]";
    }

    std::string RegisteredStoreOffersJson()
    {
        std::vector<RegisteredStoreOffer> snapshot;
        {
            std::scoped_lock lock(g_publicApiMutex);
            snapshot = g_registeredStoreOffers;
        }
        std::string json = "[";
        for (std::size_t index = 0; index < snapshot.size(); ++index) {
            if (index) json += ',';
            const auto& offer = snapshot[index];
            json += "{\"appId\":" + JsString(offer.ownerId) + ",\"id\":" + JsString(offer.id) +
                ",\"name\":" + JsString(offer.name) + ",\"description\":" + JsString(offer.description) +
                ",\"image\":" + JsString(offer.image) + ",\"price\":" + std::to_string(offer.price) +
                ",\"category\":\"api-offer\"}";
        }
        return json + "]";
    }

    bool IsEligibleRandomStoreForm(RE::TESForm* form)
    {
        if (!form || !form->GetFormID() || form->IsDeleted() ||
            (form->GetFormFlags() & RE::TESForm::RecordFlags::kNonPlayable) != 0) return false;

        const char* rawName = form->GetName();
        if (!rawName || !*rawName) return false;
        const std::string_view name(rawName);
        switch (form->GetFormType()) {
        case RE::FormType::Weapon:
        case RE::FormType::Armor:
            if (form->GetGoldValue() < 150 && !form->HasKeywordByEditorID("VendorItemUnique")) return false;
            return !form->HasKeywordByEditorID("VendorItemQuest");
        case RE::FormType::SoulGem: {
            if (form->HasKeywordByEditorID("VendorItemQuest")) return false;
            std::string normalized(name);
            std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
                return static_cast<char>(std::tolower(ch));
            });
            return normalized.find("black") != std::string::npos;
        }
        default:
            return false;
        }
    }

    void AddStoreCandidate(RE::TESForm* form, std::string_view category, std::string_view description,
        std::uint64_t& seen)
    {
        if (!IsEligibleRandomStoreForm(form)) return;
        std::string plugin;
        if (const auto* file = form->GetFile(); file && !file->GetFilename().empty()) plugin = file->GetFilename();
        StoreCandidate candidate{ form->GetFormID(), form->GetName(), std::string(category), std::string(description),
            std::move(plugin), form->GetLocalFormID() };
        ++seen;
        if (g_storeCandidates.size() < kStoreCandidateCacheLimit) {
            g_storeCandidates.push_back(std::move(candidate));
            return;
        }
        std::uniform_int_distribution<std::uint64_t> choose(0, seen - 1);
        const auto slot = choose(g_storeRng);
        if (slot < kStoreCandidateCacheLimit) g_storeCandidates[static_cast<std::size_t>(slot)] = std::move(candidate);
    }

    void BuildStoreCandidateCache()
    {
        if (g_storeCandidatesLoaded) return;
        auto* dataHandler = RE::TESDataHandler::GetSingleton();
        if (!dataHandler) {
            SKSE::log::warn("SkyMissions SkyStore stock scan skipped: TESDataHandler is unavailable");
            return;
        }

        g_storeCandidatesLoaded = true;
        const auto scanStarted = std::chrono::steady_clock::now();
        g_storeCandidates.clear();
        g_storeCandidates.reserve(kStoreCandidateCacheLimit);
        std::uint64_t seen{};
        for (auto* weapon : dataHandler->GetFormArray<RE::TESObjectWEAP>()) {
            AddStoreCandidate(weapon, "Weapons", "Rare weapon from a loaded game or mod record.", seen);
        }
        for (auto* armor : dataHandler->GetFormArray<RE::TESObjectARMO>()) {
            AddStoreCandidate(armor, "Armor", "Rare armor from a loaded game or mod record.", seen);
        }
        for (auto* soulGem : dataHandler->GetFormArray<RE::TESSoulGem>()) {
            AddStoreCandidate(soulGem, "Soul Gems", "Black soul gem from a loaded game or mod record.", seen);
        }
        const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - scanStarted).count();
        SKSE::log::info("SkyMissions SkyStore stock scan complete: eligibleRecords={}, cachedCandidates={}, elapsedMs={}",
            seen, g_storeCandidates.size(), elapsed);
    }

    std::string FormIdHex(RE::FormID formID)
    {
        constexpr char digits[] = "0123456789ABCDEF";
        std::string result(8, '0');
        for (int i = 7; i >= 0; --i) {
            result[static_cast<std::size_t>(i)] = digits[formID & 0x0F];
            formID >>= 4;
        }
        return result;
    }

    std::string SafePluginName(std::string_view plugin)
    {
        std::string safePlugin;
        safePlugin.reserve(plugin.size());
        for (const unsigned char ch : plugin) {
            if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
                (ch >= '0' && ch <= '9') || ch == '-' || ch == '_') {
                safePlugin.push_back(static_cast<char>(ch));
            } else if (ch == '.') {
                safePlugin.push_back('_');
            }
        }
        return safePlugin.empty() ? "UnknownPlugin" : safePlugin;
    }

    fs::path GameRoot()
    {
        std::array<wchar_t, 32768> executable{};
        const auto length = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
        if (!length || length >= executable.size()) return {};
        return fs::path(std::wstring(executable.data(), length)).parent_path();
    }

    fs::path StoreIconPath(const StoreCandidate& candidate)
    {
        const auto root = GameRoot();
        if (root.empty()) return {};
        return root / L"Data" / L"SKSE" / L"Plugins" / L"SkyOS" / L"Mods" / L"SkyCounterUI" /
            L"Icons" / SafePluginName(candidate.plugin) / (FormIdHex(candidate.localFormID) + ".png");
    }

    bool HasValidPngSignature(const fs::path& path)
    {
        std::error_code error;
        if (!fs::is_regular_file(path, error) || error || fs::file_size(path, error) < 8 || error) return false;
        constexpr std::array<unsigned char, 8> signature{ 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A };
        std::array<unsigned char, signature.size()> actual{};
        std::ifstream input(path, std::ios::binary);
        return input.read(reinterpret_cast<char*>(actual.data()), static_cast<std::streamsize>(actual.size())) && actual == signature;
    }

    std::string JsString(std::string_view text)
    {
        std::string out = "\"";
        for (const unsigned char ch : text) {
            switch (ch) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default: if (ch < 0x20) out += '?'; else out += static_cast<char>(ch); break;
            }
        }
        return out + '"';
    }

    std::string ToUtf8(const std::wstring& value)
    {
        if (value.empty()) return {};
        const int length = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
        if (length <= 0) return {};
        std::string result(static_cast<std::size_t>(length), '\0');
        if (WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), length, nullptr, nullptr) != length) return {};
        return result;
    }

    std::string FileUrl(const fs::path& path)
    {
        auto wide = path.wstring();
        std::replace(wide.begin(), wide.end(), L'\\', L'/');
        const auto utf8 = ToUtf8(wide);
        if (utf8.empty()) return {};
        std::string result = "file:///";
        constexpr char hex[] = "0123456789ABCDEF";
        for (const unsigned char ch : utf8) {
            if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ||
                ch == '/' || ch == ':' || ch == '-' || ch == '_' || ch == '.' || ch == '~') {
                result.push_back(static_cast<char>(ch));
            } else {
                result.push_back('%');
                result.push_back(hex[ch >> 4]);
                result.push_back(hex[ch & 0x0F]);
            }
        }
        std::error_code timeError;
        const auto modified = fs::last_write_time(path, timeError);
        if (!timeError) result += "?v=" + std::to_string(modified.time_since_epoch().count());
        return result;
    }

    bool IsArtworkFile(const fs::path& path)
    {
        auto extension = path.extension().wstring();
        std::transform(extension.begin(), extension.end(), extension.begin(), [](wchar_t ch) { return static_cast<wchar_t>(std::towlower(ch)); });
        return extension == L".png" || extension == L".jpg" || extension == L".jpeg" ||
            extension == L".gif" || extension == L".webp";
    }

    std::vector<fs::path> ArtworkIn(const fs::path& directory)
    {
        std::vector<fs::path> files;
        std::error_code error;
        for (fs::directory_iterator it(directory, error), end; !error && it != end; it.increment(error)) {
            std::error_code fileError;
            if (it->is_regular_file(fileError) && !fileError && IsArtworkFile(it->path())) files.push_back(it->path());
        }
        std::sort(files.begin(), files.end(), [](const fs::path& left, const fs::path& right) {
            auto leftName = left.filename().wstring();
            auto rightName = right.filename().wstring();
            std::transform(leftName.begin(), leftName.end(), leftName.begin(), [](wchar_t ch) { return static_cast<wchar_t>(std::towlower(ch)); });
            std::transform(rightName.begin(), rightName.end(), rightName.begin(), [](wchar_t ch) { return static_cast<wchar_t>(std::towlower(ch)); });
            return leftName < rightName;
        });
        return files;
    }

    std::string ReadSkyMissionsModuleSetting(std::string_view settingId, std::string_view fallback)
    {
        std::array<wchar_t, 32768> localAppData{};
        const auto length = GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData.data(), static_cast<DWORD>(localAppData.size()));
        if (!length || length >= localAppData.size()) return std::string(fallback);
        const fs::path settingsPath = fs::path(std::wstring(localAppData.data(), length)) /
            L"SkyOS" / L"SkyViewer" / L"SkyMissions" / L"settings.json";
        std::ifstream stream(settingsPath, std::ios::binary);
        if (!stream) return std::string(fallback);
        const std::string settings((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
        const auto key = settings.find(JsString(settingId));
        if (key == std::string::npos) return std::string(fallback);
        const auto colon = settings.find(':', key);
        if (colon == std::string::npos) return std::string(fallback);
        const auto quote = settings.find('"', colon + 1);
        if (quote == std::string::npos) return std::string(fallback);
        const auto end = settings.find('"', quote + 1);
        if (end == std::string::npos) return std::string(fallback);
        return settings.substr(quote + 1, end - quote - 1);
    }

    bool ReadSkyMissionsModuleBoolean(std::string_view settingId, bool fallback)
    {
        std::array<wchar_t, 32768> localAppData{};
        const auto length = GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData.data(), static_cast<DWORD>(localAppData.size()));
        if (!length || length >= localAppData.size()) return fallback;
        const fs::path settingsPath = fs::path(std::wstring(localAppData.data(), length)) /
            L"SkyOS" / L"SkyViewer" / L"SkyMissions" / L"settings.json";
        std::ifstream stream(settingsPath, std::ios::binary);
        if (!stream) return fallback;
        const std::string settings((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
        const auto key = settings.find(JsString(settingId));
        if (key == std::string::npos) return fallback;
        const auto colon = settings.find(':', key);
        if (colon == std::string::npos) return fallback;
        const auto value = settings.find_first_not_of(" \t\r\n", colon + 1);
        if (value == std::string::npos) return fallback;
        if (settings.compare(value, 4, "true") == 0) return true;
        if (settings.compare(value, 5, "false") == 0) return false;
        return fallback;
    }

    std::uint32_t ReadSkyMissionsModuleDuration(std::string_view settingId, std::uint32_t fallback)
    {
        std::array<wchar_t, 32768> localAppData{};
        const auto length = GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData.data(), static_cast<DWORD>(localAppData.size()));
        if (!length || length >= localAppData.size()) return fallback;
        const fs::path settingsPath = fs::path(std::wstring(localAppData.data(), length)) /
            L"SkyOS" / L"SkyViewer" / L"SkyMissions" / L"settings.json";
        std::ifstream stream(settingsPath, std::ios::binary);
        if (!stream) return fallback;
        const std::string settings((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
        const auto key = settings.find(JsString(settingId));
        if (key == std::string::npos) return fallback;
        const auto colon = settings.find(':', key);
        if (colon == std::string::npos) return fallback;
        const auto value = settings.find_first_not_of(" \t\r\n", colon + 1);
        if (value == std::string::npos) return fallback;
        std::uint32_t duration{};
        const auto parsed = std::from_chars(settings.data() + value, settings.data() + settings.size(), duration);
        if (parsed.ec != std::errc{} || parsed.ptr == settings.data() + value) return fallback;
        if (parsed.ptr != settings.data() + settings.size() && *parsed.ptr != ',' && *parsed.ptr != '}' &&
            *parsed.ptr != ' ' && *parsed.ptr != '\t' && *parsed.ptr != '\r' && *parsed.ptr != '\n') return fallback;
        return std::clamp(duration, 500U, 3000U);
    }

    std::wstring PreferredPlayerCardFormat()
    {
        std::string format = ReadSkyMissionsModuleSetting("playerCardFormat", "png");
        std::transform(format.begin(), format.end(), format.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
        if (format != "png" && format != "jpg" && format != "gif") return L"png";
        return std::wstring(format.begin(), format.end());
    }

    std::string PreferredPlayerCardNameColor()
    {
        const auto color = ReadSkyMissionsModuleSetting("playerCardNameColor", "#F4D28D");
        if (color.size() != 7 || color.front() != '#') return "#F4D28D";
        if (!std::all_of(color.begin() + 1, color.end(), [](unsigned char ch) { return std::isxdigit(ch) != 0; })) return "#F4D28D";
        return color;
    }

    std::string PreferredPlayerCardNameFont()
    {
        const auto font = ReadSkyMissionsModuleSetting("playerCardNameFont", "cinzel");
        constexpr std::array<std::string_view, 12> allowed{
            "cinzel", "georgia", "palatino", "times", "cambria", "garamond", "papyrus",
            "trebuchet", "segoe", "candara", "copperplate", "impact"
        };
        return std::find(allowed.begin(), allowed.end(), font) != allowed.end() ? font : "cinzel";
    }

    bool PlayerOwnsHomeCell(RE::TESObjectCELL* cell, RE::PlayerCharacter* player, RE::TESFaction* playerFaction)
    {
        if (!cell || !player) return false;
        if (auto* factionOwner = cell->GetFactionOwner(); factionOwner &&
            (factionOwner == playerFaction || player->IsInFaction(factionOwner))) return true;
        const auto* playerBase = player->GetActorBase();
        if (cell->GetActorOwner() == playerBase) return true;
        const auto* owner = cell->GetOwner();
        if (owner == player || owner == playerBase || owner == playerFaction) return true;
        const auto* ownerFaction = owner && owner->Is(RE::TESFaction::FORMTYPE)
            ? static_cast<const RE::TESFaction*>(owner)
            : nullptr;
        return ownerFaction && player->IsInFaction(ownerFaction);
    }

    std::string DefaultPropertiesJson()
    {
        struct HomeCell { std::string_view name; RE::FormID localFormID; std::string_view plugin; };
        constexpr std::array<HomeCell, 9> homes{{
            {"Breezehome", 0x165A8, "Skyrim.esm"},
            {"Honeyside", 0x16BDD, "Skyrim.esm"},
            {"Vlindrel Hall", 0x16DFA, "Skyrim.esm"},
            {"Hjerim", 0x16778, "Skyrim.esm"},
            {"Proudspire Manor", 0x16A06, "Skyrim.esm"},
            {"Heljarchen Hall", 0x16A56, "HearthFires.esm"},
            {"Lakeview Manor", 0x2FEC, "HearthFires.esm"},
            {"Windstad Manor", 0x11CB3, "HearthFires.esm"},
            {"Severin Manor", 0x17EBE, "Dragonborn.esm"}
        }};
        auto* player = RE::PlayerCharacter::GetSingleton();
        auto* dataHandler = RE::TESDataHandler::GetSingleton();
        auto* playerFaction = dataHandler
            ? static_cast<RE::TESFaction*>(dataHandler->LookupForm(0xDB1, "Skyrim.esm"))
            : nullptr;
        std::string result = "[";
        bool first = true;
        for (const auto& home : homes) {
            auto* cell = dataHandler
                ? static_cast<RE::TESObjectCELL*>(dataHandler->LookupForm(home.localFormID, home.plugin))
                : nullptr;
            const bool owned = PlayerOwnsHomeCell(cell, player, playerFaction);
            if (!cell) {
                SKSE::log::info("SkyMissions vanilla property '{}' unavailable: CELL {:08X} in '{}' was not found (DLC may be disabled)",
                    home.name, home.localFormID, home.plugin);
            } else {
                const auto* ownerFaction = cell->GetFactionOwner();
                const auto* owner = cell->GetOwner();
                SKSE::log::info("SkyMissions resolved property '{}': cellFormID={:08X}, cellEditorID='{}', ownerFormID={:08X}, ownerFactionFormID={:08X}, playerOwned={}",
                    home.name, cell->GetFormID(), cell->GetFormEditorID() ? cell->GetFormEditorID() : "",
                    owner ? owner->GetFormID() : 0, ownerFaction ? ownerFaction->GetFormID() : 0, owned);
            }
            if (!first) result += ',';
            first = false;
            result += "{\"name\":" + JsString(home.name) + ",\"available\":" + (cell ? "true" : "false") +
                ",\"owned\":" + (owned ? "true" : "false") + "}";
        }
        return result + "]";
    }

    std::string ArtworkJson(const std::vector<fs::path>& files)
    {
        std::string json = "[";
        bool first = true;
        for (const auto& file : files) {
            const auto stem = ToUtf8(file.stem().wstring());
            const auto url = FileUrl(file);
            if (url.empty()) continue;
            if (!first) json += ',';
            first = false;
            json += "{\"name\":" + JsString(stem) + ",\"url\":" + JsString(url) + "}";
        }
        return json + "]";
    }
}

namespace SkyOS {
    std::string GetSkyMissionsPlayerUpdateScript()
    {
        auto* player = RE::PlayerCharacter::GetSingleton();
        const char* playerName = player ? player->GetName() : "";
        const auto level = player ? player->GetLevel() : 0;
        auto* actorValues = player ? player->AsActorValueOwner() : nullptr;
        const auto health = actorValues ? actorValues->GetActorValue(RE::ActorValue::kHealth) : 0.0F;
        const auto magicka = actorValues ? actorValues->GetActorValue(RE::ActorValue::kMagicka) : 0.0F;
        const auto stamina = actorValues ? actorValues->GetActorValue(RE::ActorValue::kStamina) : 0.0F;
        const auto followers = player ? player->GetInfoRuntimeData().teammateCount : 0U;
        const auto* base = player ? player->GetActorBase() : nullptr;
        const auto gender = base && base->GetSex() == RE::SEX::kFemale ? "female" : "male";
        std::string factions = "[";
        bool firstFaction = true;
        if (player) {
            if (auto* dataHandler = RE::TESDataHandler::GetSingleton()) {
                for (auto* faction : dataHandler->GetFormArray<RE::TESFaction>()) {
                    if (!faction || !player->IsInFaction(faction)) continue;
                    const char* name = faction->GetName();
                    if (!name || !*name) name = faction->GetFormEditorID();
                    if (!name || !*name) continue;
                    if (!firstFaction) factions += ',';
                    firstFaction = false;
                    factions += "{\"name\":" + JsString(name) + ",\"editorID\":" + JsString(faction->GetFormEditorID() ? faction->GetFormEditorID() : "") +
                        ",\"formID\":" + std::to_string(faction->GetFormID()) + ",\"rank\":" + std::to_string(player->GetFactionRank(faction, true)) + "}";
                }
            }
        }
        factions += ']';
        return GetSkyMissionsAssetsUpdateScript() + ";SkyOS.setSkyMissionsPlayer(" + JsString(playerName ? playerName : "") + "," +
            std::to_string(level) + "," + std::to_string(health) + "," + std::to_string(magicka) + "," +
            std::to_string(stamina) + "," + std::to_string(followers) + "," + JsString(gender) + "," + JsString(factions) + ")";
    }

    std::string GetSkyMissionsAssetsUpdateScript()
    {
        const auto root = GameRoot() / L"Data" / L"SKSE" / L"Plugins" / L"SkyOS" / L"Mods" / L"SkyMissions";
        const auto achievementsRoot = GameRoot() / L"Data" / L"SKSE" / L"Plugins" / L"SkyOS" / L"Mods" / L"SkyAchievements";
        std::string playerCard = "null";
        const auto preferredFormat = PreferredPlayerCardFormat();
        const wchar_t* preferredName = preferredFormat == L"jpg" ? L"Player Card.jpg" : preferredFormat == L"gif" ? L"Player Card.gif" : L"Player Card.png";
        const wchar_t* pngName = L"Player Card.png";
        const wchar_t* jpgName = L"Player Card.jpg";
        const wchar_t* gifName = L"Player Card.gif";
        const std::array<const wchar_t*, 4> playerCardNames{ preferredName, pngName, jpgName, gifName };
        std::wstring previousName;
        for (const wchar_t* filename : playerCardNames) {
            if (previousName == filename) continue;
            previousName = filename;
            const auto path = root / L"Player Card" / filename;
            std::error_code error;
            if (fs::is_regular_file(path, error) && !error) {
                const auto url = FileUrl(path);
                if (!url.empty()) playerCard = JsString(url);
                break;
            }
        }
        const auto nameCards = ArtworkJson(ArtworkIn(root / L"Name Cards"));
        const auto achievements = ArtworkJson(ArtworkIn(achievementsRoot / L"Achievements"));
        const auto properties = DefaultPropertiesJson();
        const auto missions = RegisteredMissionsJson();
        const auto storeOffers = RegisteredStoreOffersJson();
        return "SkyOS.setSkyMissionsAssets({\"playerCard\":" + playerCard + ",\"playerNameColor\":" + JsString(PreferredPlayerCardNameColor()) +
            ",\"playerNameFont\":" + JsString(PreferredPlayerCardNameFont()) + ",\"nameCards\":" + nameCards +
            ",\"achievements\":" + achievements + ",\"properties\":" + properties +
            ",\"apiMissions\":" + missions + ",\"apiStoreOffers\":" + storeOffers + "})";
    }

    std::string GetSkyMissionsStoreItemsUpdateScript()
    {
        BuildStoreCandidateCache();
        std::vector<std::size_t> order(g_storeCandidates.size());
        std::iota(order.begin(), order.end(), 0);
        std::shuffle(order.begin(), order.end(), g_storeRng);
        const auto count = std::min(kRandomStoreItemLimit, order.size());
        const auto generation = ++g_storeGeneration;
        std::uniform_int_distribution<std::uint32_t> priceRange(500, 10000);
        std::vector<RE::FormID> selectedFormIDs;
        selectedFormIDs.reserve(count);
        std::string items = "[";
        for (std::size_t index = 0; index < count; ++index) {
            if (index) items += ',';
            const auto& candidate = g_storeCandidates[order[index]];
            const auto formHex = FormIdHex(candidate.formID);
            selectedFormIDs.push_back(candidate.formID);
            const auto iconPath = StoreIconPath(candidate);
            const auto icon = HasValidPngSignature(iconPath) ? JsString(FileUrl(iconPath)) : std::string("\"\"");
            const auto offerId = "game-item:" + formHex + ":" + std::to_string(generation) + ":" + std::to_string(index);
            items += "{\"id\":" + JsString(offerId) + ",\"name\":" + JsString(candidate.name) +
                ",\"category\":\"game-item\",\"itemType\":" + JsString(candidate.category) +
                ",\"description\":" + JsString(candidate.description) + ",\"appId\":\"SkyMissions\",\"appName\":\"SkyMissions\",\"price\":" +
                std::to_string(priceRange(g_storeRng)) + ",\"formId\":" + JsString(formHex) + ",\"image\":" + icon + "}";
        }
        items += ']';
        {
            std::scoped_lock lock(g_storeStockMutex);
            g_currentStoreFormIDs = std::move(selectedFormIDs);
        }
        SKSE::log::info("SkyMissions SkyStore generated stock: itemCount={}, generation={}", count, generation);
        return "SkyOS.setSkyMissionsStoreItems({\"items\":" + items + ",\"generation\":" + std::to_string(generation) + "})";
    }

    void RequestSkyMissionsStoreItemIcons(SkyMissionsStoreIconRequestCallback callback)
    {
        if (!callback) return;
        std::vector<RE::FormID> formIDs;
        {
            std::scoped_lock lock(g_storeStockMutex);
            formIDs = g_currentStoreFormIDs;
        }
        for (const auto formID : formIDs) callback(formID);
    }

    void RequestSkyMissionsStoreItemIconsForForms(const std::uint32_t* requestedFormIDs,
        std::size_t count, SkyMissionsStoreIconRequestCallback callback)
    {
        if (!callback || !requestedFormIDs || count == 0) return;
        constexpr std::size_t kMaxRequestedIcons = 10;
        std::vector<RE::FormID> formIDs;
        formIDs.reserve(std::min(count, kMaxRequestedIcons));
        for (std::size_t index = 0; index < count && formIDs.size() < kMaxRequestedIcons; ++index) {
            const auto formID = requestedFormIDs[index];
            if (!formID || std::find(formIDs.begin(), formIDs.end(), formID) != formIDs.end()) continue;
            auto* form = RE::TESForm::LookupByID(formID);
            if (!IsEligibleRandomStoreForm(form)) {
                SKSE::log::warn("SkyMissions SkyStore ignored icon request for unavailable or ineligible form {:08X}", formID);
                continue;
            }
            formIDs.push_back(formID);
        }
        {
            std::scoped_lock lock(g_storeStockMutex);
            g_currentStoreFormIDs = formIDs;
        }
        SKSE::log::info("SkyMissions SkyStore accepted persisted-stock icon requests: requested={}, accepted={}",
            std::min(count, kMaxRequestedIcons), formIDs.size());
        for (const auto formID : formIDs) callback(formID);
    }

    std::string GetSkyMissionsStoreItemIconUpdateScript(std::uint32_t formID, std::string_view iconUrl)
    {
        if (!formID || iconUrl.empty()) return {};
        {
            std::scoped_lock lock(g_storeStockMutex);
            if (std::find(g_currentStoreFormIDs.begin(), g_currentStoreFormIDs.end(), formID) == g_currentStoreFormIDs.end()) return {};
        }
        return "SkyOS.setSkyMissionsStoreItemIcon(" + JsString(FormIdHex(formID)) + "," + JsString(iconUrl) + ")";
    }

    bool QueueSkyMissionsStorePurchase(std::string_view offerId, std::uint32_t price)
    {
        constexpr std::string_view prefix = "game-item:";
        if (price < 500 || price > 10000 || !offerId.starts_with(prefix) || offerId.size() < prefix.size() + 9 ||
            offerId[prefix.size() + 8] != ':') {
            SKSE::log::warn("SkyMissions rejected random-item purchase: invalid offer ID or price={} SkyPoints", price);
            return false;
        }
        RE::FormID formID{};
        const auto formText = offerId.substr(prefix.size(), 8);
        const auto parsed = std::from_chars(formText.data(), formText.data() + formText.size(), formID, 16);
        if (parsed.ec != std::errc{} || parsed.ptr != formText.data() + formText.size()) {
            SKSE::log::warn("SkyMissions rejected random-item purchase: invalid form ID in offer");
            return false;
        }
        auto* form = RE::TESForm::LookupByID(formID);
        if (!IsEligibleRandomStoreForm(form)) {
            SKSE::log::warn("SkyMissions rejected random-item purchase: form {:08X} is unavailable or not eligible", formID);
            return false;
        }
        auto* tasks = SKSE::GetTaskInterface();
        if (!tasks) {
            SKSE::log::warn("SkyMissions could not queue random-item purchase {:08X}: task interface unavailable", formID);
            return false;
        }
        tasks->AddTask([formID, price] {
            auto* currentForm = RE::TESForm::LookupByID(formID);
            auto* player = RE::PlayerCharacter::GetSingleton();
            if (!player || !IsEligibleRandomStoreForm(currentForm)) {
                SKSE::log::warn("SkyMissions random-item grant cancelled: player or eligible form {:08X} unavailable", formID);
                return;
            }
            player->AddObjectToContainer(static_cast<RE::TESBoundObject*>(currentForm), nullptr, 1, nullptr);
            SKSE::log::info("SkyMissions granted SkyStore item: form={:08X}, name='{}', price={} SkyPoints",
                formID, currentForm->GetName() ? currentForm->GetName() : "", price);
        });
        return true;
    }

    std::string GetSkyMissionsMissionNoticeScript(std::string_view missionTitle, std::uint32_t reward)
    {
        if (!ReadSkyMissionsModuleBoolean("missionNoticeEnabled", true)) return {};
        const auto designSetting = ReadSkyMissionsModuleSetting("missionNoticeDesign", "dwemer-ledger");
        constexpr std::array<std::string_view, 4> designs{
            "dwemer-ledger", "frost-seal", "quest-banner", "minimal"
        };
        const auto design = std::find(designs.begin(), designs.end(), designSetting) != designs.end()
            ? designSetting : std::string("dwemer-ledger");

        const auto positionSetting = ReadSkyMissionsModuleSetting("missionNoticePosition", "top-center");
        constexpr std::array<std::string_view, 9> positions{
            "top-left", "top-center", "top-right", "center-left", "center-center", "center-right",
            "bottom-left", "bottom-center", "bottom-right"
        };
        const auto position = std::find(positions.begin(), positions.end(), positionSetting) != positions.end()
            ? positionSetting : std::string("top-center");
        const auto sizeSetting = ReadSkyMissionsModuleSetting("missionNoticeSize", "large");
        constexpr std::array<std::string_view, 3> sizes{ "large", "standard", "compact" };
        const auto size = std::find(sizes.begin(), sizes.end(), sizeSetting) != sizes.end()
            ? sizeSetting : std::string("large");
        const auto durationMs = ReadSkyMissionsModuleDuration("missionNoticeDurationMs", 1500);
        return "SkyMissionNotice.show(" + JsString(missionTitle) + "," + std::to_string(reward) + "," +
            JsString(design) + "," + JsString(position) + "," + std::to_string(durationMs) + "," + JsString(size) + ")";
    }
}

extern "C" __declspec(dllexport) std::uint32_t __cdecl SkyMissions_GetAPIVersion()
{
    return SKYMISSIONS_API_VERSION;
}

extern "C" __declspec(dllexport) std::int32_t __cdecl SkyMissions_RegisterMissionV1(
    const SkyMissionsMissionV1* definition)
{
    if (!definition || definition->structSize < sizeof(SkyMissionsMissionV1) ||
        !definition->eventType || !definition->goal || definition->goal > 1000000 || definition->reward > 1000000) return 0;

    RegisteredMission mission{};
    mission.eventType = definition->eventType;
    mission.goal = definition->goal;
    mission.reward = definition->reward;
    mission.formID = definition->formID;
    mission.baseFormID = definition->baseFormID;
    if (!CopyApiIdentity(definition->ownerId, sizeof(definition->ownerId), mission.ownerId) ||
        !CopyApiIdentity(definition->id, sizeof(definition->id), mission.id) ||
        !CopyApiText(definition->title, sizeof(definition->title), sizeof(definition->title) - 1, mission.title, true) ||
        !CopyApiText(definition->description, sizeof(definition->description), sizeof(definition->description) - 1, mission.description) ||
        !CopyApiText(definition->subjectContains, sizeof(definition->subjectContains), sizeof(definition->subjectContains) - 1, mission.subjectContains) ||
        !CopyApiText(definition->identityContains, sizeof(definition->identityContains), sizeof(definition->identityContains) - 1, mission.identityContains)) return 0;

    std::scoped_lock lock(g_publicApiMutex);
    const auto existing = std::find_if(g_registeredMissions.begin(), g_registeredMissions.end(), [&](const auto& value) {
        return value.ownerId == mission.ownerId && value.id == mission.id;
    });
    if (existing != g_registeredMissions.end()) {
        *existing = std::move(mission);
        return 2;
    }
    if (g_registeredMissions.size() >= 64) return 0;
    g_registeredMissions.push_back(std::move(mission));
    return 1;
}

extern "C" __declspec(dllexport) std::int32_t __cdecl SkyMissions_RegisterStoreOfferV1(
    const SkyMissionsStoreOfferV1* definition)
{
    if (!definition || definition->structSize < sizeof(SkyMissionsStoreOfferV1) || definition->price > 1000000) return 0;

    RegisteredStoreOffer offer{};
    offer.price = definition->price;
    if (!CopyApiIdentity(definition->ownerId, sizeof(definition->ownerId), offer.ownerId) ||
        !CopyApiIdentity(definition->id, sizeof(definition->id), offer.id) ||
        !CopyApiText(definition->name, sizeof(definition->name), sizeof(definition->name) - 1, offer.name, true) ||
        !CopyApiText(definition->description, sizeof(definition->description), sizeof(definition->description) - 1, offer.description) ||
        !CopyApiText(definition->image, sizeof(definition->image), sizeof(definition->image) - 1, offer.image)) return 0;
    if (!offer.image.empty() && !offer.image.starts_with("https://") && !offer.image.starts_with("http://") &&
        !offer.image.starts_with("file:///")) return 0;

    std::scoped_lock lock(g_publicApiMutex);
    const auto existing = std::find_if(g_registeredStoreOffers.begin(), g_registeredStoreOffers.end(), [&](const auto& value) {
        return value.ownerId == offer.ownerId && value.id == offer.id;
    });
    if (existing != g_registeredStoreOffers.end()) {
        *existing = std::move(offer);
        return 2;
    }
    if (g_registeredStoreOffers.size() >= 256) return 0;
    g_registeredStoreOffers.push_back(std::move(offer));
    return 1;
}
