// The BROWSE screen: discover published generators (shared storage, newest-first
// with vote counts) and manage "My generators" (the viewer's own drafts +
// published rows). Presentation only — data + actions come from the App.

import { useState } from 'react';

import { Alert, Badge, Button, Card, Group, Loader, Modal, Stack } from '@civitai/blocks-react/ui';

import type { SharedListItem } from '@civitai/blocks-react';
import type { StoredDraft } from '../lib/drafts.js';
import type { GeneratorData } from '../types.js';
import type { Palette } from '../theme.js';

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
      <Group justify="space-between">
        <h1 style={{ margin: 0, fontSize: 22 }}>Custom Generators</h1>
        <Button size="sm" data-testid="create-generator" onClick={onCreate}>
          + Create
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
          {loading && <Loader data-testid="discover-loading" />}
          {!loading && discover.length === 0 && (
            <p style={{ color: c.muted, fontSize: 14 }} data-testid="discover-empty">
              No published generators yet. Create the first one!
            </p>
          )}
          {discover.map((item) => (
            <PublishedCard key={item.key} item={item} c={c} onOpen={() => onOpenPublished(item)} />
          ))}
        </Stack>
      )}

      {tab === 'mine' && (
        <Stack gap={16} data-testid="mine-list">
          <Stack gap={10}>
            <div style={{ fontSize: 13, color: c.muted }}>Drafts</div>
            {myDrafts.length === 0 && (
              <p style={{ color: c.muted, fontSize: 14 }} data-testid="drafts-empty">
                No drafts yet.
              </p>
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
            <div style={{ fontSize: 13, color: c.muted }}>Published by me</div>
            {myPublished.length === 0 && (
              <p style={{ color: c.muted, fontSize: 14 }} data-testid="published-empty">
                You haven't published a generator yet.
              </p>
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
  return (
    <Card withBorder padding="md" data-testid="published-card" data-key={item.key}>
      <Stack gap={10}>
        {coverUrl && (
          <img
            data-testid="published-cover"
            src={coverUrl}
            alt=""
            style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 8, border: `1px solid ${c.border}`, display: 'block' }}
          />
        )}
        <Group justify="space-between">
          <div>
            <div style={{ fontWeight: 600 }}>{item.value.title || 'Untitled generator'}</div>
            <div style={{ fontSize: 12, color: c.muted }} data-testid="published-desc">
              {(item.value.body ?? '').split('\n')[0]}
            </div>
          </div>
          <Group gap={8}>
            <Badge variant="light" data-testid="published-votes">
              ▲ {item.count}
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
