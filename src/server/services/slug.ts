/**
 * Slug helpers. A task's slug is also its git branch name and the session-root
 * dir name, so it must be filesystem- and git-ref-safe.
 *
 * The canonical entry point is {@link makeSlug}, which returns a unique
 * identifier of the shape `"<id>-<slug>"` (e.g. `"a1b2-add-login-flow"`), where
 * the 4-char id prefix guarantees uniqueness across tasks that share a title.
 */
import { customAlphabet } from "nanoid";

/** Max length of the human-readable slug portion (excluding the id prefix). */
const MAX_SLUG_LEN = 40;

/**
 * URL-safe, lowercase alphabet for the id prefix. Avoids `_`/`-` so the prefix
 * never collides with the kebab separator and the result stays branch-safe.
 */
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Generate a 4-char lowercase-alphanumeric id. */
const shortId = customAlphabet(ID_ALPHABET, 4);

/**
 * Derive a branch/dir-safe slug body from a free-text title. Lowercases, strips
 * accents, replaces runs of non-alphanumerics with single hyphens, trims, and
 * caps the result at {@link MAX_SLUG_LEN} characters (trimmed back so it never
 * ends on a stray hyphen).
 */
export function slugify(title: string): string {
  let body = title
    .toLowerCase()
    .normalize("NFKD")
    // Drop combining marks left over from NFKD (accents, etc.).
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (body.length > MAX_SLUG_LEN) {
    body = body.slice(0, MAX_SLUG_LEN).replace(/-+$/g, "");
  }

  return body;
}

/**
 * Build a unique, branch/dir-safe slug from a title: `"<id>-<slug>"`.
 *
 * When the title slugifies to an empty string (e.g. all punctuation), the id
 * alone is used so the result is still a valid ref.
 */
export function makeSlug(title: string): string {
  const id = shortId();
  const body = slugify(title);
  return body ? `${id}-${body}` : id;
}
