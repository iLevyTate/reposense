/**
 * GitHub URL construction.
 *
 * Lives in one place because the inspector panel and shift-click both need it,
 * and two copies of a URL builder drift.
 */

/**
 * Encodes a slash-separated path for use in a URL path.
 *
 * `encodeURI` is wrong here: it deliberately leaves `#` and `?` alone because
 * they are legal URL syntax, so a file called `notes#2.md` silently truncates
 * into a fragment. Encoding each segment escapes those while keeping the
 * separators intact.
 */
export function encodePath(path) {
  return String(path)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

/**
 * Blob URL for a file, or tree URL for a folded "…N more files" bundle.
 *
 * @param {{url?:string, branch?:string}} repo
 * @param {{path:string, bundle?:number}} file
 * @returns {string} empty when the dataset has no GitHub origin (a local scan
 *   of a repository with no remote)
 */
export function githubUrlFor(repo, file) {
  if (!repo?.url || !file?.path) return '';
  // Branch names may contain slashes (`claude/some-feature`), which must stay
  // literal for GitHub to resolve the ref, so encode segment-wise here too.
  const branch = encodePath(repo.branch || 'HEAD') || 'HEAD';
  if (file.bundle) {
    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    return dir ? `${repo.url}/tree/${branch}/${encodePath(dir)}` : `${repo.url}/tree/${branch}`;
  }
  return `${repo.url}/blob/${branch}/${encodePath(file.path)}`;
}
