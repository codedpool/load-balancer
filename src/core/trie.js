// Path-segment Trie used for longest-prefix route matching.
// A route prefix like "/users" is stored segment by segment; an incoming
// request path is walked until the first node marked as a route end.

class TrieNode {
  constructor() {
    this.children = new Map();
    this.isEnd = false;
  }
}

export class Trie {
  constructor() {
    this.root = new TrieNode();
  }

  insert(path) {
    const segments = splitPath(path);
    let node = this.root;

    for (const seg of segments) {
      if (!node.children.has(seg)) {
        node.children.set(seg, new TrieNode());
      }
      node = node.children.get(seg);
    }
    node.isEnd = true;
  }

  // Returns { matched, matchedPath } for the longest registered prefix
  // that the given URL path begins with.
  matchPrefix(url) {
    const segments = splitPath(url);
    let node = this.root;
    const pathParts = [];

    let matched = false;
    let matchedPath = '';

    for (const seg of segments) {
      const next = node.children.get(seg);
      if (!next) {
        break;
      }
      node = next;
      pathParts.push(seg);
      if (node.isEnd) {
        matched = true;
        matchedPath = '/' + pathParts.join('/');
        break;
      }
    }

    return { matched, matchedPath };
  }
}

function splitPath(path) {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') {
    return [];
  }
  return trimmed.split('/');
}
