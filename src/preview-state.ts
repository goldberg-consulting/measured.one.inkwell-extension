/** Identity attached to every asynchronous preview operation and message. */
export interface PreviewRevision {
  readonly revision: number;
  readonly documentUri: string;
  readonly sourceVersion: number;
}

export interface PreviewRun extends PreviewRevision {
  readonly runId: number;
}

/** Pure latest-request-wins state; starting work invalidates prior completions. */
export class PreviewState {
  private revision = 0;
  private active: PreviewRevision | undefined;

  get current(): PreviewRevision | undefined {
    return this.active;
  }

  begin(documentUri: string, sourceVersion: number): PreviewRevision {
    this.active = Object.freeze({ revision: ++this.revision, documentUri, sourceVersion });
    return this.active;
  }

  isCurrent(request: PreviewRevision | undefined): request is PreviewRevision {
    return !!request && this.active?.revision === request.revision &&
      this.active.documentUri === request.documentUri &&
      this.active.sourceVersion === request.sourceVersion;
  }

  clear(): void {
    ++this.revision;
    this.active = undefined;
  }
}
