import { CheckCheck, Inbox, Loader2 } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { TFunction } from 'i18next';

import { LLMProviderLogo, Tooltip } from '@/shared/ui';
import { cn } from '@/shared/utils';
import { useProcessingSessions } from '@/shared/context/SessionProtectionContext';
import type { Project, ProjectSession, SessionActivity, SessionRowActions, SessionWithProvider, SidebarInboxItem, SidebarInboxSection } from '@/shared/types';
import { createSessionViewModel, formatCompactAge } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import SessionOptions from '@/modules/sidebar/SessionOptions';

type SidebarInboxProps = {
  /** Already filtered by the search box and in display order. */
  items: SidebarInboxItem[];
  /** Inbox size before the search filter, to tell "empty" from "no match". */
  totalCount: number;
  selectedSession: ProjectSession | null;
  currentTime: Date;
  sessionActions: SessionRowActions;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectId: string) => void;
  onClearSeen: () => void;
  t: TFunction;
};

const SECTIONS: readonly SidebarInboxSection[] = ['needs-you', 'unseen', 'working'];

const getSectionTitle = (section: SidebarInboxSection, t: TFunction): string => {
  switch (section) {
    case 'needs-you':
      return t('inbox.sectionNeedsYou', 'Needs you');
    case 'unseen':
      return t('inbox.sectionUnseen', 'Done · unseen');
    case 'working':
      return t('inbox.sectionWorking', 'Working');
  }
};

// The second line of a row: what the session is waiting on or doing, and since when.
const getRowStatus = (
  item: SidebarInboxItem,
  activity: SessionActivity | undefined,
  currentTime: Date,
  t: TFunction,
): { label: string; age: string } => {
  const ageSince = (epochMs: number | undefined) => (
    epochMs ? formatCompactAge(new Date(epochMs).toISOString(), currentTime) : ''
  );

  if (item.section === 'working') {
    return {
      label: activity?.background
        ? t('tooltips.backgroundWorkIndicator', 'Background work running')
        : activity?.statusText || t('inbox.statusWorking', 'Working…'),
      age: ageSince(activity?.startedAt),
    };
  }

  const markedAge = ageSince(item.attention?.at);
  if (item.attention?.reason === 'needs-input') {
    return { label: t('inbox.statusNeedsInput', 'Waiting for your answer'), age: markedAge };
  }
  if (item.attention?.reason === 'error') {
    return { label: t('inbox.statusError', 'Stopped with an error'), age: markedAge };
  }
  return { label: t('inbox.statusDone', 'Finished'), age: markedAge };
};

function InboxStatusMark({ item, activity }: { item: SidebarInboxItem; activity: SessionActivity | undefined }) {
  if (item.section === 'working') {
    return activity?.background
      ? <span className="h-2 w-2 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" />
      : <Loader2 className="h-3 w-3 animate-spin text-emerald-500" />;
  }

  return (
    <span
      className={cn(
        'h-2 w-2 rounded-full',
        item.attention?.reason === 'needs-input' && 'animate-pulse bg-amber-500',
        item.attention?.reason === 'error' && 'bg-red-500',
        item.attention?.reason === 'done' && 'bg-sky-500',
      )}
    />
  );
}

/**
 * Rendered by SidebarContent in the inbox mode: every session that is running,
 * blocked on the user, or finished while the user was elsewhere, across all
 * projects. A session leaves on its own once it has been opened and is idle,
 * so there is nothing to dismiss row by row.
 */
export default function SidebarInbox({
  items,
  totalCount,
  selectedSession,
  currentTime,
  sessionActions,
  onProjectSelect,
  onSessionSelect,
  onClearSeen,
  t,
}: SidebarInboxProps) {
  // Subscribed here rather than in the sidebar: only the inbox shows status
  // lines, and it is the only list that re-renders on each status frame.
  const processingSessions = useProcessingSessions();

  if (items.length === 0) {
    return (
      <div className="px-4 py-12 text-center md:py-8" data-testid="sidebar-inbox-empty">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-border/70 bg-muted/50 md:mb-3">
          <Inbox className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
          {t('inbox.emptyTitle', 'All caught up')}
        </h3>
        <p className="text-sm text-muted-foreground">
          {totalCount > 0
            ? t('inbox.noMatchingSessions', 'No inbox sessions match this search.')
            : t('inbox.emptyDescription', 'Sessions show up here while they run, and stay until you have looked at what they finished.')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 px-1" data-testid="sidebar-inbox">
      {SECTIONS.map((section) => {
        const sectionItems = items.filter((item) => item.section === section);
        if (sectionItems.length === 0) {
          return null;
        }

        return (
          <section key={section} data-testid={`sidebar-inbox-section-${section}`}>
            <div className="flex items-center justify-between px-2 pb-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {getSectionTitle(section, t)}
                <span className="ml-1.5 tabular-nums text-muted-foreground/70">{sectionItems.length}</span>
              </span>
              {section === 'unseen' && (
                <Tooltip content={t('inbox.markAllSeen', 'Mark all seen')} position="left">
                  <button
                    type="button"
                    onClick={onClearSeen}
                    aria-label={t('inbox.markAllSeen', 'Mark all seen')}
                    data-testid="sidebar-inbox-mark-all-seen"
                    className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <CheckCheck className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              )}
            </div>

            <div className="space-y-0.5">
              {sectionItems.map((item) => {
                const { session, project } = item;
                const isSelected = String(selectedSession?.id ?? '') === session.id;
                const activity = processingSessions.get(session.id);
                const isProcessing = sessionActions.activeSessions.has(session.id)
                  && !sessionActions.backgroundSessionIds.has(session.id);
                const sessionName = createSessionViewModel(session, currentTime, t).sessionName;
                const status = getRowStatus(item, activity, currentTime, t);
                const rename = sessionActions.activeRename;
                const sessionRename = rename?.target === 'session' && rename.id === session.id ? rename : null;

                const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                    return;
                  }
                  event.preventDefault();
                  onProjectSelect(project);
                  onSessionSelect(session, project.projectId);
                };

                return (
                  <div key={session.id} className="group relative">
                    <a
                      href={`/session/${session.id}`}
                      onClick={handleClick}
                      data-testid="sidebar-inbox-row"
                      data-inbox-section={section}
                      className={cn(
                        'flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 pr-11 text-left transition-colors',
                        isSelected ? 'bg-primary/10 text-foreground' : 'text-foreground hover:bg-accent/60',
                      )}
                    >
                      <span className={cn(
                        'relative flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md',
                        isSelected ? 'bg-primary/10' : 'bg-muted/60',
                      )}>
                        <LLMProviderLogo provider={session.__provider} className="h-3.5 w-3.5" />
                        <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-background">
                          <InboxStatusMark item={item} activity={activity} />
                        </span>
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className={cn(
                          'block truncate text-[13px] leading-4',
                          section === 'working' ? 'font-normal' : 'font-medium',
                        )}>
                          {sessionName}
                        </span>
                        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] leading-3 text-muted-foreground">
                          <span className="max-w-[40%] flex-shrink-0 truncate">{project.displayName}</span>
                          <span className="flex-shrink-0 text-muted-foreground/40">·</span>
                          <span className="min-w-0 truncate">{status.label}</span>
                          {status.age && (
                            <span className="ml-auto flex-shrink-0 tabular-nums">{status.age}</span>
                          )}
                        </span>
                      </span>
                    </a>

                    <SessionOptions
                      className="absolute right-2 top-1/2 -translate-y-1/2 transform"
                      sessionId={session.id}
                      sessionName={sessionName}
                      provider={session.__provider}
                      projectId={project.projectId}
                      isProcessing={isProcessing}
                      isEditing={sessionRename !== null}
                      renameDraft={sessionRename?.draft ?? ''}
                      onRenameDraftChange={sessionActions.onRenameDraftChange}
                      onStartEditingSession={sessionActions.onStartEditingSession}
                      onCancelEditingSession={sessionActions.onCancelEditingSession}
                      onSaveEditingSession={sessionActions.onSaveEditingSession}
                      onDeleteSession={sessionActions.onDeleteSession}
                      onFork={sessionActions.onForkSession ? () => sessionActions.onForkSession?.(session) : undefined}
                      t={t}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
