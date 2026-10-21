import * as React from 'react';
import type { PageId, ViewContext } from './types.js';
import { OrchestrationView } from './views.js';
import { ConnectionsView, ContextView, QualityView, RecoveryView, ResourcesView, SearchView } from './domain-views.js';
import { GlobalFeatureView, globalFeatureLabels } from './global-feature-view.js';
import { GlobalOverview } from './scope-views.js';
import { isAuxiliaryPage } from './catalog.js';

/** Global summaries are an explicit view of one feature, never the page router. */
export function FeaturePage({ context, page, summary = false }: { context: ViewContext; page: PageId; summary?: boolean }) {
  if (!isAuxiliaryPage(page, context.scope.level ?? 'global')) return null;
  if (context.scope.level === 'global') {
    if (summary) return <GlobalOverview context={context} page={page} />;
    if (page in globalFeatureLabels) return <GlobalFeatureView context={context} page={page} />;
  }
  // Scope changes must retire selections, previews and in-flight callbacks
  // together, before controls for the next identity become interactive.
  const identity = JSON.stringify([page, context.scope.level, context.scope.workspaceId, context.scope.sessionId]);
  switch (page) {
    case 'orchestration': return <OrchestrationView context={context} />;
    case 'cache': return <ContextView context={context} />;
    case 'quality': case 'review': return <QualityView context={context} review={page === 'review'} />;
    case 'recovery': return <RecoveryView key={identity} context={context} />;
    case 'resources': case 'extensions': return <ResourcesView key={identity} context={context} extensions={page === 'extensions'} />;
    case 'connections': return <ConnectionsView context={context} />;
    case 'search': return <SearchView key={identity} context={context} />;
    default: return null;
  }
}
