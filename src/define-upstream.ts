// Registers the upstream @civitai/components elements this app renders
// directly: the sidebar navigation (civitai-nav-list / civitai-nav-item)
// and the Discover sort menu (civitai-menu / civitai-menu-item). Each
// /define module is the package's own idempotent registrar. Imported for
// side effects by components/Browse.tsx, the one surface that renders them.
import '@civitai/components/civitai-nav-list/define';
import '@civitai/components/civitai-nav-item/define';
import '@civitai/components/civitai-menu/define';
import '@civitai/components/civitai-menu-item/define';
