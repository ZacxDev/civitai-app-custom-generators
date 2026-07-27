// The BROWSE screen: discover published generators (shared storage, newest-first
// with vote counts) and manage "My generators" (the viewer's own drafts +
// published rows). Presentation only — data + actions come from the App.

import { useState } from 'react';
import type { CSSProperties } from 'react';

import { Alert, Badge, Button, Card, Group, Loader, Modal, Stack } from '@civitai/blocks-react/ui';

import type { SharedListItem } from '@civitai/blocks-react';
import type { StoredDraft } from '../lib/drafts.js';
import type { GeneratorData } from '../types.js';
import { token, radius, metaText, type Palette } from '../theme.js';
import { EmptyState } from './EmptyState.js';
import { SafeImage } from './SafeImage.js';

type Tab = 'discover' | 'mine';

export interface BrowseProps {
  c: Palette;
  loading: boolean;
  error: string | null;
  discover: SharedListItem[];
  myDrafts: StoredDraft[];
  myPublished: SharedListItem[];
  viewerId: number | null;
  onCreate: () => void;
  onOpenPublished: (item: SharedListItem) => void;
  onOpenDraft: (draft: StoredDraft) => void;
  onEditDraft: (draft: StoredDraft) => void;
  onDeleteDraft: (draft: StoredDraft) => void;
  /** Withdraw one of the viewer's OWN published generators (shared_kv row). */
  onDeletePublished: (item: SharedListItem) => void | Promise<void>;
  onRetry: () => void;
}

/**
 * The cosmetic cover image url for a published generator, read from the opaque
 * `data` blob. Accepts the new `headerImageRef` AND the legacy
 * `backgroundImageRef` (rows published before the header-image rename).
 */
function headerImageUrl(item: SharedListItem): string | undefined {
  const data = item.value.data as GeneratorData | undefined;
  return (data?.headerImageRef ?? data?.backgroundImageRef)?.url;
}

export function Browse(props: BrowseProps) {
  const { c, loading, error, discover, myDrafts, myPublished, onCreate, onOpenPublished, onOpenDraft, onEditDraft, onDeleteDraft, onDeletePublished, onRetry } = props;
  const [tab, setTab] = useState<Tab>('discover');
  // Confirm-gated withdraw of an own published generator.
  const [pendingDelete, setPendingDelete] = useState<SharedListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await onDeletePublished(pendingDelete);
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Stack gap={16} data-testid="browse">
      <Group
        justify="space-between"
        align="center"
        gap={12}
        style={{ paddingBottom: 14, borderBottom: `1px solid ${token.border}` }}
      >
        <Group gap={12} align="center" wrap={false} style={{ minWidth: 0 }}>
          <span aria-hidden="true" style={brandMarkStyle}>
            <WandIcon />
          </span>
          <Stack gap={2} style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 19, letterSpacing: '-0.01em', lineHeight: 1.2 }}>
              Custom Generators
            </h1>
            <span style={metaText}>Build and run one-tap image generators</span>
          </Stack>
        </Group>
        <Button data-testid="create-generator" leftSection="+" onClick={onCreate}>
          Create
        </Button>
      </Group>

      <Group gap={8} role="tablist" aria-label="Generator source">
        <Button
          size="sm"
          variant={tab === 'discover' ? 'filled' : 'subtle'}
          role="tab"
          aria-selected={tab === 'discover'}
          data-testid="tab-discover"
          onClick={() => setTab('discover')}
        >
          Discover
        </Button>
        <Button
          size="sm"
          variant={tab === 'mine' ? 'filled' : 'subtle'}
          role="tab"
          aria-selected={tab === 'mine'}
          data-testid="tab-mine"
          onClick={() => setTab('mine')}
        >
          My generators
        </Button>
      </Group>

      {error && (
        <Alert color="error" data-testid="browse-error">
          {error}{' '}
          <Button size="sm" variant="light" data-testid="browse-retry" onClick={onRetry}>
            Retry
          </Button>
        </Alert>
      )}

      {tab === 'discover' && (
        <Stack gap={10} data-testid="discover-list">
          {loading && (
            <Group gap={8} data-testid="discover-loading" role="status" aria-live="polite">
              <Loader size="sm" />
              <span style={metaText}>Loading generators…</span>
            </Group>
          )}
          {!loading && discover.length === 0 && (
            <EmptyState
              data-testid="discover-empty"
              title="No published generators yet"
              body="Build a set of one-tap generation buttons and publish it for everyone to run."
              action={
                <Button size="sm" data-testid="discover-empty-create" onClick={onCreate}>
                  Create the first one
                </Button>
              }
            />
          )}
          {discover.map((item) => (
            <PublishedCard key={item.key} item={item} c={c} onOpen={() => onOpenPublished(item)} />
          ))}
        </Stack>
      )}

      {tab === 'mine' && (
        <Stack gap={16} data-testid="mine-list">
          <Stack gap={10}>
            <div style={{ fontSize: 13, color: c.muted, fontWeight: 600 }}>Drafts</div>
            {myDrafts.length === 0 && (
              <EmptyState
                data-testid="drafts-empty"
                title="No drafts yet"
                body="Start a generator and save it as a draft to pick up later."
                action={
                  <Button size="sm" variant="light" data-testid="drafts-empty-create" onClick={onCreate}>
                    New generator
                  </Button>
                }
              />
            )}
            {myDrafts.map((d) => (
              <Card key={d.id} withBorder padding="md" data-testid="draft-card" data-draft-id={d.id}>
                <Group justify="space-between">
                  <div>
                    <div style={{ fontWeight: 600 }}>{d.config.name || 'Untitled generator'}</div>
                    <div style={{ fontSize: 12, color: c.muted }}>
                      {d.config.buttons.length} button{d.config.buttons.length === 1 ? '' : 's'}
                      {d.publishedKey ? ' · published' : ' · draft'}
                    </div>
                  </div>
                  <Group gap={6}>
                    <Button size="sm" variant="subtle" data-testid="draft-delete" color="error" onClick={() => onDeleteDraft(d)}>
                      Delete
                    </Button>
                    <Button size="sm" variant="light" data-testid="draft-edit" onClick={() => onEditDraft(d)}>
                      Edit
                    </Button>
                    <Button size="sm" data-testid="draft-open" onClick={() => onOpenDraft(d)}>
                      Run
                    </Button>
                  </Group>
                </Group>
              </Card>
            ))}
          </Stack>

          <Stack gap={10}>
            <div style={{ fontSize: 13, color: c.muted, fontWeight: 600 }}>Published by me</div>
            {myPublished.length === 0 && (
              <EmptyState
                data-testid="published-empty"
                title="Nothing published yet"
                body="Publish a generator from the builder to share it in Discover."
              />
            )}
            {myPublished.map((item) => (
              <PublishedCard
                key={item.key}
                item={item}
                c={c}
                onOpen={() => onOpenPublished(item)}
                onDelete={() => setPendingDelete(item)}
              />
            ))}
          </Stack>
        </Stack>
      )}

      {/* Confirm-gated withdraw. `withdraw` permanently removes the shared_kv row
          (and its votes) — so gate it behind an explicit confirmation. */}
      <Modal
        opened={!!pendingDelete}
        onClose={() => (deleting ? undefined : setPendingDelete(null))}
        title="Delete published generator?"
        size="sm"
      >
        <Stack gap={14} data-testid="delete-published-modal">
          <p style={{ margin: 0, fontSize: 14 }}>
            This removes <strong>{pendingDelete?.value.title || 'this generator'}</strong> from Discover for
            everyone, along with its votes. This can't be undone.
          </p>
          <Group justify="flex-end" gap={8}>
            <Button
              variant="subtle"
              size="sm"
              data-testid="cancel-delete-published"
              disabled={deleting}
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </Button>
            <Button
              color="error"
              size="sm"
              data-testid="confirm-delete-published"
              loading={deleting}
              onClick={confirmDelete}
            >
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

/** A tinted rounded tile that holds the brand mark (matches the manifest's
 * `wand` page icon), styled entirely off `--civitai-*` tokens. */
const brandMarkStyle: CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  width: 38,
  height: 38,
  flexShrink: 0,
  borderRadius: radius.md,
  color: token.primary,
  background: token.primaryLight,
  border: `1px solid ${token.border}`,
};

/** Inline `wand` glyph (currentColor), no external icon dependency. */
function WandIcon(): React.JSX.Element {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15 6l3 3M5 19L16.5 7.5a1.8 1.8 0 0 0 0-2.5l-.5-.5a1.8 1.8 0 0 0-2.5 0L2 16l3 3z"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M18 3l.6 1.4L20 5l-1.4.6L18 7l-.6-1.4L16 5l1.4-.6zM6 3l.4 1L7.5 4.5 6.5 5 6 6l-.5-1L4.5 4.5 5.5 4z" fill="currentColor" />
    </svg>
  );
}

function PublishedCard({
  item,
  c,
  onOpen,
  onDelete,
}: {
  item: SharedListItem;
  c: Palette;
  onOpen: () => void;
  /** When present, renders a confirm-gated Delete affordance (own published only). */
  onDelete?: () => void;
}) {
  const coverUrl = headerImageUrl(item);
  const desc = (item.value.body ?? '').split('\n')[0];
  return (
    <Card withBorder padding="md" data-testid="published-card" data-key={item.key}>
      <Stack gap={10}>
        {coverUrl && (
          // A broken/dead cover URL (withdrawn image, offline host) collapses
          // gracefully rather than leaving a broken glyph dominating the card.
          <SafeImage
            data-testid="published-cover"
            src={coverUrl}
            alt=""
            style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: radius.md, border: `1px solid ${c.border}`, display: 'block' }}
          />
        )}
        <Group justify="space-between" align="flex-start" gap={12}>
          <div style={{ flex: '1 1 200px', minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{item.value.title || 'Untitled generator'}</div>
            {desc && (
              <div style={{ ...metaText, marginTop: 2 }} data-testid="published-desc">
                {desc}
              </div>
            )}
          </div>
          <Group gap={8} wrap={false}>
            <Badge variant="light" data-testid="published-votes">
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>▲ {item.count}</span>
            </Badge>
            {onDelete && (
              <Button size="sm" variant="subtle" color="error" data-testid="published-delete" onClick={onDelete}>
                Delete
              </Button>
            )}
            <Button size="sm" data-testid="published-open" onClick={onOpen}>
              Open
            </Button>
          </Group>
        </Group>
      </Stack>
    </Card>
  );
}
