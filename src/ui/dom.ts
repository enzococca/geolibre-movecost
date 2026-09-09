/** Tiny DOM helpers. The host renders plugin panels from plain DOM, not React. */

type Attrs = Record<string, string | number | boolean | undefined | null>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key.startsWith("data-") || key === "role" || key === "aria-label") {
      node.setAttribute(key, String(value));
    } else if (key in node) {
      (node as unknown as Record<string, unknown>)[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export interface FieldOptions {
  hint?: string;
  inline?: boolean;
}

export function field(label: string, control: HTMLElement, options: FieldOptions = {}) {
  const wrapper = el(
    "label",
    { class: options.inline ? "mcx-field mcx-field--inline" : "mcx-field" },
    el("span", { class: "mcx-field__label", text: label }),
    control,
    options.hint ? el("span", { class: "mcx-field__hint", text: options.hint }) : null,
  );
  return wrapper;
}

export interface SelectOption {
  value: string;
  label: string;
  group?: string;
}

export function select(
  options: SelectOption[],
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const node = el("select", { class: "mcx-select" });
  const groups = new Map<string, HTMLOptGroupElement>();

  for (const option of options) {
    const optionNode = el("option", { value: option.value, text: option.label });
    if (option.group) {
      let group = groups.get(option.group);
      if (!group) {
        group = el("optgroup", { label: option.group });
        groups.set(option.group, group);
        node.append(group);
      }
      group.append(optionNode);
    } else {
      node.append(optionNode);
    }
  }

  node.value = value;
  node.addEventListener("change", () => onChange(node.value));
  return node;
}

export function numberInput(
  value: number,
  onChange: (value: number) => void,
  attrs: { min?: number; max?: number; step?: number } = {},
): HTMLInputElement {
  const node = el("input", {
    class: "mcx-input",
    type: "number",
    value: String(value),
    ...attrs,
  });
  node.addEventListener("change", () => {
    const parsed = Number(node.value);
    if (Number.isFinite(parsed)) onChange(parsed);
    else node.value = String(value);
  });
  return node;
}

export function textInput(
  value: string,
  onChange: (value: string) => void,
  placeholder?: string,
): HTMLInputElement {
  const node = el("input", {
    class: "mcx-input",
    type: "text",
    value,
    placeholder: placeholder ?? "",
  });
  node.addEventListener("change", () => onChange(node.value));
  return node;
}

export function checkbox(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
  hint?: string,
): HTMLElement {
  const input = el("input", { class: "mcx-checkbox", type: "checkbox", checked });
  input.addEventListener("change", () => onChange(input.checked));
  return el(
    "label",
    { class: "mcx-check" },
    input,
    el("span", { text: label }),
    hint ? el("span", { class: "mcx-field__hint", text: hint }) : null,
  );
}

export function button(
  label: string,
  onClick: () => void,
  variant: "primary" | "secondary" | "ghost" | "danger" = "secondary",
): HTMLButtonElement {
  const node = el("button", {
    class: `mcx-button mcx-button--${variant}`,
    type: "button",
    text: label,
  });
  node.addEventListener("click", onClick);
  return node;
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return el(
    "section",
    { class: "mcx-section" },
    el("h3", { class: "mcx-section__title", text: title }),
    ...children,
  );
}

export function note(text: string, tone: "info" | "warn" | "error" = "info"): HTMLElement {
  return el("p", { class: `mcx-note mcx-note--${tone}`, text });
}

/** Formats a byte count for the DTM summary line. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
