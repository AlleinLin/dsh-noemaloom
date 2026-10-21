import type { NexusModule, NexusServices } from '../ports/contracts.js';
import { createMemoryModule } from './memory/index.js';
import { createContextModule } from './context/index.js';
import { createWorkflowModule, createAgentsModule } from './workflow/index.js';
import { createQualityModule } from './quality/index.js';
import { createReviewModule } from './review/index.js';
import { createArtifactModule } from './artifacts/index.js';
import { createRecoveryModule } from './recovery/index.js';
import { createGraphModule } from './graph/index.js';
import { createExtensionsModule } from './extensions/index.js';
import { createPresetsModule } from './runtime/presets/index.js';
import { createFilesModule } from './files/index.js';
import { createRuntimeModule } from './runtime/index.js';
import { createUsageModule } from './usage/index.js';
import { createResourcesModule } from './resources/index.js';
import { createConnectionsModule } from './integrations/index.js';
import { createSearchModule } from '../adapters/search/index.js';
import { workspaceModules } from './workspace-runtime.js';
import { createScopeModule, withScopePolicy } from './scope.js';
import { createInsightsModule } from './insights/index.js';
import { createAutonomyModule } from './autonomy/index.js';
import { createCompanionModule } from './insights/companion.js';

/** One composition root; every UI/tool/remote request shares these instances. */
export async function registerDomainModules(services: NexusServices, register: (module: NexusModule) => void): Promise<void> {
  register(createScopeModule(services));
  for (const module of await workspaceModules(services, [
    createWorkflowModule, createAgentsModule, createQualityModule, createReviewModule,
    createArtifactModule, createRecoveryModule, createGraphModule, createRuntimeModule,
    createConnectionsModule, createPresetsModule, createSearchModule,
  ])) register(withScopePolicy(module, services));
  for (const factory of [
    createMemoryModule, createContextModule, createExtensionsModule,
    createFilesModule, createUsageModule, createResourcesModule, createInsightsModule, createAutonomyModule, createCompanionModule,
  ]) register(withScopePolicy(await factory(services), services));
}
