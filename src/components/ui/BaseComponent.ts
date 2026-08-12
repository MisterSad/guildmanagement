/**
 * src/components/ui/BaseComponent.ts
 *
 * Abstract base UI component class providing lifecycle hooks,
 * reactive state mounting, and automatic event listener cleanup.
 */

export abstract class BaseComponent<Props = {}, State = {}> {
  protected container: HTMLElement | null = null;
  protected props: Props;
  protected state: State;
  private eventDisposers: Array<() => void> = [];

  constructor(props: Props, initialState: State) {
    this.props = props;
    this.state = initialState;
  }

  public mount(container: HTMLElement): void {
    this.unmount();
    this.container = container;
    this.render();
  }

  public unmount(): void {
    this.eventDisposers.forEach((dispose) => dispose());
    this.eventDisposers = [];
    if (this.container) {
      this.container.innerHTML = '';
      this.container = null;
    }
  }

  public setState(partial: Partial<State>): void {
    this.state = { ...this.state, ...partial };
    if (this.container) {
      this.render();
    }
  }

  protected addEventListener(
    element: HTMLElement,
    type: string,
    listener: EventListenerOrEventListenerObject
  ): void {
    element.addEventListener(type, listener);
    this.eventDisposers.push(() => {
      element.removeEventListener(type, listener);
    });
  }

  protected abstract template(): string;

  protected render(): void {
    if (!this.container) return;
    this.container.innerHTML = this.template();
    this.onRendered();
  }

  protected onRendered(): void {}
}
