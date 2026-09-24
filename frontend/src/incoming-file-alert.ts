/** Plays once per offer when the receiver needs to notice an incoming file. */
export class IncomingFileAlert {
  private offered = new Set<string>();
  private alerted = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private play: () => void,
    private page: Document = document,
    private browserWindow: Window = window,
  ) {
    this.page.addEventListener('visibilitychange', this.onAttentionLost);
    this.browserWindow.addEventListener('blur', this.onAttentionLost);
  }

  update(offeredIds: string[]) {
    const next = new Set(offeredIds);
    for (const id of this.offered) {
      if (next.has(id)) continue;
      this.offered.delete(id);
      this.alerted.delete(id);
      this.clearTimer(id);
    }
    for (const id of next) {
      if (this.offered.has(id)) continue;
      this.offered.add(id);
      if (this.page.visibilityState === 'hidden' || !this.page.hasFocus()) this.alert(id);
      else this.timers.set(id, setTimeout(() => this.alert(id), 3000));
    }
  }

  dispose() {
    this.page.removeEventListener('visibilitychange', this.onAttentionLost);
    this.browserWindow.removeEventListener('blur', this.onAttentionLost);
    for (const id of this.timers.keys()) this.clearTimer(id);
    this.offered.clear();
    this.alerted.clear();
  }

  private onAttentionLost = () => {
    if (this.page.visibilityState !== 'hidden' && this.page.hasFocus()) return;
    for (const id of this.offered) this.alert(id);
  };

  private alert(id: string) {
    if (!this.offered.has(id) || this.alerted.has(id)) return;
    this.alerted.add(id);
    this.clearTimer(id);
    this.play();
  }

  private clearTimer(id: string) {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
  }
}
