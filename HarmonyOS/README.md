# SubFabric HarmonyOS

HarmonyOS ArkTS adaptation of SubFabric. The project is kept in this folder so Android and HarmonyOS can be released independently.

## Preview 0.1

- Release tag: preview-0.1
- App version field: preview{0.1}. HarmonyOS version schema accepts letters only when wrapped in braces.
- The release HAP is built without local ASR models.
- encoder.ms, decoder_joint.ms, tiny.ms, vocab.txt, and model manifests are intentionally excluded from this repository and release package.

## Build

Open HarmonyOS as the project root in DevEco Studio. Configure a local signing profile in Project Structure before installing a HAP.

    hvigorw --mode module -p product=default -p buildMode=release assembleHap

The app can use downloaded or user-imported models through the model management screen. NPU inference requires a compatible real device. The emulator package is intended for UI verification.

## Layout

- common/ contains platform-independent subtitle, timing, ASS, and pipeline code.
- entry/ contains ArkUI pages, media integration, native NAPI modules, and prebuilt media libraries.
- docs/ contains HarmonyOS design, media, model, and verification notes.
- tools/ contains conversion and validation helpers.

No user projects, videos, credentials, local model weights, build outputs, or DevEco local configuration are included.
