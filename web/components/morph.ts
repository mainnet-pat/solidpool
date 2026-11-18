// Updating a part of the page in place. Setting innerHTML replaces every element under it, so a
// refresh that changes one number still makes the whole part flash and every image load again.
// morph() makes the part what the new markup describes while touching only what differs.

/** What tells two elements apart when they are compared in place: a key, an asset, or an id. */
function keyOf(node: Node): string | undefined {
  if (!(node instanceof Element)) return undefined;
  return node.getAttribute('data-key') ?? node.getAttribute('data-asset') ?? (node.id === '' ? undefined : node.id);
}

/** Whether `next` can be written into `current` rather than replace it. */
function sameKind(current: Node, next: Node): boolean {
  if (current.nodeType !== next.nodeType) return false;
  if (!(current instanceof Element) || !(next instanceof Element)) return true;
  return current.tagName === next.tagName && keyOf(current) === keyOf(next);
}

function syncAttributes(current: Element, next: Element): void {
  for (const { name } of Array.from(current.attributes)) {
    if (!next.hasAttribute(name)) current.removeAttribute(name);
  }
  for (const { name, value } of Array.from(next.attributes)) {
    if (current.getAttribute(name) !== value) current.setAttribute(name, value);
  }
}

function morphChildren(target: Node, source: Node): void {
  // A snapshot, since writing a node into the page moves it out of `source`.
  const wanted = Array.from(source.childNodes);
  for (let index = 0; index < wanted.length; index += 1) {
    const next = wanted[index];
    const current = target.childNodes[index];
    if (current === undefined) {
      target.appendChild(next);
    } else if (current.isEqualNode(next)) {
      // Already right: left alone, image and all.
    } else if (!sameKind(current, next)) {
      target.replaceChild(next, current);
    } else if (current instanceof Element && next instanceof Element) {
      syncAttributes(current, next);
      morphChildren(current, next);
    } else if (current.nodeValue !== next.nodeValue) {
      current.nodeValue = next.nodeValue;
    }
  }
  while (target.childNodes.length > wanted.length) target.lastChild!.remove();
}

/**
 * Make `target`'s children what `html` describes, touching only what differs. A node that is
 * already right stays as it is; an element of the same tag and key (data-key, data-asset or id) is
 * updated in place, attribute by attribute and child by child; only the rest is replaced. So a
 * refresh that changes a count changes that text, and an image loads again only if its address
 * changed. Handlers set on elements that stay are kept.
 */
export function morph(target: Element, html: string): void {
  const template = document.createElement('template');
  template.innerHTML = html;
  morphChildren(target, template.content);
}
