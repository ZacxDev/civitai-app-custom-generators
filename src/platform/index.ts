// The platform seam.
//
// Everything the app used to import from `@civitai/blocks-react` comes from here,
// under the same names and the same signatures. `App.tsx` — 1,034 lines calling
// eighteen hooks — changed at its import block and nowhere else.
//
// 🔴 ONLY FILES UNDER `src/platform/` MAY IMPORT `@civitai/sdk`. That is what
// makes this a seam rather than a folder, and `src/platform-seam.test.ts` asserts
// both halves of it with a positive control.
//
// Where each surface went (the full map is in the PR body):
//   host UI      → `app.host.*`               resource picker, image upload,
//                                             publish, purchase, navigate, resize
//   consent      → `app.requestGrants`
//   viewer/token → the transport snapshot
//   data         → `app.site.*` over `/api/v1/blocks/*`  shared storage, workflows,
//                                             gated images, generation resources, buzz
//   per-viewer KV→ `app.storage`
//   post         → still the bridge; there is deliberately no REST route

export { getClient, getPlatformTransport, getSnapshot, __configurePlatform } from './client.js';
export type { PlatformOverrides } from './client.js';

export {
  useBlockAnalytics,
  useBlockContext,
  useBlockResize,
  useBlockToken,
  useBuzzBalance,
  useBuzzPurchase,
  useCivitaiNavigate,
  useImageUpload,
  usePublishGenerationOutputs,
  useRequestConsent,
  useRequestSignIn,
  useResourcePicker,
  requestGrants,
} from './hooks.js';
export type {
  BlockContextValue,
  BlockTokenValue,
  PurchaseResult,
  UseBlockAnalytics,
  UseBuzzBalance,
  UseBuzzPurchase,
  UseCivitaiNavigate,
  UseImageUpload,
  UsePublishGenerationOutputs,
  UseRequestConsent,
  UseRequestSignIn,
  UseResourcePicker,
  UseSourceImageUpload,
} from './hooks.js';

export { createWorkflowClient, useBuzzWorkflow, WorkflowEstimateError, HOST_SYNTHESISED_WORKFLOW_ID } from './workflows.js';
export type { UseBuzzWorkflow, WorkflowClient, WorkflowEstimateErrorCode } from './workflows.js';

export { createSharedStorage } from './sharedStorage.js';
export { useSharedStorage } from './useSharedStorage.js';
export type {
  SharedAppendValue,
  SharedListItem,
  SharedListResult,
  SharedStorage,
  UseSharedStorage,
} from './types.js';

export { fetchGatedImages, IMAGE_IDS_BATCH_MAX } from './images.js';
export { useGatedImages } from './useGatedImages.js';

export { fetchGenerationResources, RESOURCE_IDS_BATCH_MAX } from './resources.js';
export { useGenerationResources } from './useGenerationResources.js';

export { fetchBuzzBalance } from './buzz.js';
export type { BuzzBalance } from './buzz.js';

export { useAppStorage } from './appStorage.js';

export {
  createPost,
  CreatePostError,
  CREATE_POST_ERROR_CODES,
  isCreatePostErrorCode,
  HUMAN_INTERACTION_TIMEOUT_MS,
} from './createPost.js';
export { useCreatePostFromApp } from './useCreatePostFromApp.js';
export type { UseCreatePostFromApp } from './useCreatePostFromApp.js';

export { BlockGate, DirectLoadFallback, hostToRunUrl, useDirectLoad } from './BlockGate.js';
export type { BlockGateProps, DirectLoadFallbackProps } from './BlockGate.js';
