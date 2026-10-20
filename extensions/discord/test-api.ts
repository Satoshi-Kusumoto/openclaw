// Discord test API exposes transcript-provider fixtures without deep extension imports.
export const loadDiscordDraftPreview = () =>
  import("./src/monitor/message-handler.draft-preview.js");
export { RequestClient } from "./src/internal/discord.js";
// Cross-instance core binding tests can reset Discord's global thread-binding state without deep extension imports.
export { resetThreadBindingsForTests } from "./src/monitor/thread-bindings.test-support.js";
export {
  discordVoiceTranscriptsSourceProvider,
  setDiscordTranscriptsVoiceManager,
} from "./src/voice/transcripts-source.js";

// Voice harness mocks must remain opt-in for provider-only integration tests.
export const loadDiscordVoiceTestHarness = () =>
  import("./src/voice/voice-test-harness.test-support.js");

// Gateway capture proof keeps routing/admission real; only transport edges are substituted.
export const loadDiscordGatewayCaptureFixture = () =>
  import("./src/voice/voice-gateway-capture.test-support.js");
