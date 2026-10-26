#ifndef SKYMISSIONS_PUBLIC_API_H
#define SKYMISSIONS_PUBLIC_API_H

/*
 * SkyMissions public C ABI, version 1.
 * Resolve these exports from the already-loaded SkyMissions.dll with
 * GetProcAddress. This header does not require a SkyMissions import library.
 */
#include <stdint.h>
#pragma push_macro("InterlockedCompareExchange")
#include <windows.h>
#pragma pop_macro("InterlockedCompareExchange")

#ifdef __cplusplus
extern "C" {
#endif

#define SKYMISSIONS_API_VERSION 1u
#define SKYMISSIONS_STORE_PURCHASE_MESSAGE ((uint32_t)(('S' << 24) | ('M' << 16) | ('P' << 8) | 'S'))

/*
 * Register an event-driven, per-character mission. eventType uses the public
 * SkyRewrite journal event values. Zero form IDs and empty text filters mean
 * "match any". Register during plugin initialization; repeated owner/id pairs
 * replace their earlier definition.
 */
typedef struct SkyMissionsMissionV1 {
    uint32_t structSize;
    uint32_t eventType;
    uint32_t goal;
    uint32_t reward;
    uint32_t formID;
    uint32_t baseFormID;
    char ownerId[81];
    char id[101];
    char title[101];
    char description[257];
    char subjectContains[101];
    char identityContains[101];
} SkyMissionsMissionV1;

/*
 * Register an offer in SkyStore. image is an optional http(s):// or file:///
 * URL. On purchase, SkyMissions broadcasts SKYMISSIONS_STORE_PURCHASE_MESSAGE
 * with a SkyMissionsStorePurchaseV1 payload for the owning plugin to fulfill.
 */
typedef struct SkyMissionsStoreOfferV1 {
    uint32_t structSize;
    uint32_t price;
    char ownerId[81];
    char id[101];
    char name[101];
    char description[257];
    char image[512];
} SkyMissionsStoreOfferV1;

typedef struct SkyMissionsStorePurchaseV1 {
    uint32_t version;
    uint32_t price;
    char moduleId[81];
    char offerId[101];
    char name[101];
} SkyMissionsStorePurchaseV1;

typedef uint32_t (__cdecl *SkyMissionsGetAPIVersionFn)(void);
typedef int32_t (__cdecl *SkyMissionsRegisterMissionV1Fn)(const SkyMissionsMissionV1* mission);
typedef int32_t (__cdecl *SkyMissionsRegisterStoreOfferV1Fn)(const SkyMissionsStoreOfferV1* offer);

typedef struct SkyMissionsAPI {
    uint32_t structSize;
    uint32_t apiVersion;
    SkyMissionsGetAPIVersionFn getAPIVersion;
    SkyMissionsRegisterMissionV1Fn registerMissionV1;
    SkyMissionsRegisterStoreOfferV1Fn registerStoreOfferV1;
} SkyMissionsAPI;

/* Pass the already-loaded SkyMissions.dll module handle. */
static inline int32_t SkyMissions_LoadAPI(HMODULE module, SkyMissionsAPI* apiOut)
{
    if (!module || !apiOut) return 0;
    SkyMissionsAPI api = { 0 };
    api.structSize = (uint32_t)sizeof(api);
    api.getAPIVersion = (SkyMissionsGetAPIVersionFn)(void*)GetProcAddress(module, "SkyMissions_GetAPIVersion");
    api.registerMissionV1 = (SkyMissionsRegisterMissionV1Fn)(void*)GetProcAddress(module, "SkyMissions_RegisterMissionV1");
    api.registerStoreOfferV1 = (SkyMissionsRegisterStoreOfferV1Fn)(void*)GetProcAddress(module, "SkyMissions_RegisterStoreOfferV1");
    if (!api.getAPIVersion || !api.registerMissionV1 || !api.registerStoreOfferV1) return 0;
    api.apiVersion = api.getAPIVersion();
    if (api.apiVersion < SKYMISSIONS_API_VERSION) return 0;
    *apiOut = api;
    return 1;
}

#ifdef __cplusplus
}
#endif

#endif /* SKYMISSIONS_PUBLIC_API_H */
