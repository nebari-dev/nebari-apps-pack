import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Eye, Pause, Play, Search, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PhaseBadge, SourceBadge } from '@/components/app-bits';
import { api } from '@/lib/api';
import type { App } from '@/lib/types';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Spinner } from '@/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/table';
import { toast } from '@/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

const appLabel = (app: App) => app.displayName || app.name;
const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function AppsPage() {
  const queryClient = useQueryClient();
  const apps = useQuery({ queryKey: ['apps'], queryFn: () => api.listApps() });
  const [filter, setFilter] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<App | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['apps'] });
    void queryClient.invalidateQueries({ queryKey: ['analytics'] });
  };

  const stop = useMutation({
    mutationFn: (app: App) => api.stopApp(app.namespace, app.name),
    onSuccess: (_data, app) => {
      invalidate();
      toast.success(`Stopped ${appLabel(app)}`);
    },
    onError: (err, app) => toast.error(`Failed to stop ${appLabel(app)}`, errMessage(err)),
  });
  const start = useMutation({
    mutationFn: (app: App) => api.startApp(app.namespace, app.name),
    onSuccess: (_data, app) => {
      invalidate();
      toast.success(`Started ${appLabel(app)}`);
    },
    onError: (err, app) => toast.error(`Failed to start ${appLabel(app)}`, errMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (app: App) => api.deleteApp(app.namespace, app.name),
    onSuccess: (_data, app) => {
      invalidate();
      setDeleteTarget(null);
      toast.success(`Deleted ${appLabel(app)}`);
    },
    onError: (err, app) => toast.error(`Failed to delete ${appLabel(app)}`, errMessage(err)),
  });

  const rows = useMemo(() => {
    const list = apps.data ?? [];
    const term = filter.trim().toLowerCase();
    if (!term) return list;
    return list.filter((a) =>
      [a.name, a.displayName, a.namespace, a.source?.type ?? '', a.owner, a.status.phase]
        .join(' ')
        .toLowerCase()
        .includes(term),
    );
  }, [apps.data, filter]);

  const isPendingFor = (mutation: { isPending: boolean; variables?: App }, app: App) =>
    mutation.isPending &&
    mutation.variables?.namespace === app.namespace &&
    mutation.variables?.name === app.name;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-semibold text-2xl">Apps</h1>
          <p className="text-muted-foreground text-sm">
            Everything launched through the Apps Pack, across your namespaces.
          </p>
        </div>
        <Button render={<Link to="/launch">Launch app</Link>} />
      </div>

      <div className="flex items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 z-10 size-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, source, status…"
            className="pr-9 pl-9"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter ? (
            <button
              type="button"
              aria-label="Clear search"
              className="-translate-y-1/2 absolute top-1/2 right-2 z-10 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setFilter('')}
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
        {filter ? (
          <p className="shrink-0 text-muted-foreground text-sm tabular-nums">
            {rows.length} of {apps.data?.length ?? 0}
          </p>
        ) : null}
      </div>

      {apps.isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Spinner className="size-6" />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-muted-foreground text-sm">
          {filter ? 'No apps match your filter.' : 'No apps yet - launch your first one.'}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>App</TableHead>
              <TableHead>Namespace</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Replicas</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((app) => {
              const stopped = (app.status.replicas?.desired ?? app.runtime?.replicas ?? 1) === 0;
              return (
                <TableRow key={`${app.namespace}/${app.name}`}>
                  <TableCell>
                    <Link
                      to={`/apps/${app.namespace}/${app.name}`}
                      className="font-medium hover:underline"
                    >
                      {app.displayName || app.name}
                    </Link>
                    <p className="text-muted-foreground text-xs">{app.name}</p>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{app.namespace}</TableCell>
                  <TableCell>
                    <SourceBadge source={app.source?.type ?? '—'} />
                  </TableCell>
                  <TableCell>
                    <PhaseBadge phase={app.status.phase} />
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {app.status.replicas ? `${app.status.replicas.ready}/${app.status.replicas.desired}` : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{app.owner || '—'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              render={
                                // biome-ignore lint/a11y/useAnchorContent: icon child
                                <Link to={`/apps/${app.namespace}/${app.name}`} aria-label="View app" />
                              }
                            >
                              <Eye />
                            </Button>
                          }
                        />
                        <TooltipContent>View</TooltipContent>
                      </Tooltip>
                      {app.status.url && app.status.phase === 'Running' ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                render={
                                  // biome-ignore lint/a11y/useAnchorContent: icon child
                                  <a
                                    href={app.status.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    aria-label="Open app"
                                  />
                                }
                              >
                                <ExternalLink />
                              </Button>
                            }
                          />
                          <TooltipContent>Open</TooltipContent>
                        </Tooltip>
                      ) : null}
                      {stopped ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="Start app"
                                loading={isPendingFor(start, app)}
                                onClick={() => start.mutate(app)}
                              >
                                <Play />
                              </Button>
                            }
                          />
                          <TooltipContent>Start</TooltipContent>
                        </Tooltip>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="Stop app"
                                loading={isPendingFor(stop, app)}
                                onClick={() => stop.mutate(app)}
                              >
                                <Pause />
                              </Button>
                            }
                          />
                          <TooltipContent>Stop</TooltipContent>
                        </Tooltip>
                      )}
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Delete app"
                              className="text-destructive-foreground hover:bg-destructive hover:text-destructive-foreground"
                              onClick={() => setDeleteTarget(app)}
                            >
                              <Trash2 />
                            </Button>
                          }
                        />
                        <TooltipContent>Delete</TooltipContent>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.displayName || deleteTarget?.name}?</DialogTitle>
            <DialogDescription>
              This removes the app, its routing, TLS certificate, and OIDC client. It cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() => deleteTarget && remove.mutate(deleteTarget)}
            >
              Delete app
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
