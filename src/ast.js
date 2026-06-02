import { readFileSync } from 'node:fs';
import { parse as acornParse } from 'acorn';

export const PARSEABLE_EXTS = new Set(['js', 'mjs', 'cjs']);

const HTTP_METHODS  = new Set(['get', 'post', 'put', 'patch', 'delete', 'use', 'all', 'options', 'head']);
const SKIP_AST_KEYS = new Set(['type', 'loc', 'start', 'end']);

export function extractFunctions(absPath) {
  let src;
  try { src = readFileSync(absPath, 'utf8'); } catch { return []; }

  let ast;
  for (const sourceType of ['module', 'script']) {
    try {
      ast = acornParse(src, { ecmaVersion: 'latest', sourceType, locations: true });
      break;
    } catch {}
  }
  if (!ast) return [];

  const fns = [];

  function walk(node, parent) {
    if (!node || typeof node !== 'object' || !node.type) return;

    let name = null;
    const isFn = node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';

    if (node.type === 'FunctionDeclaration' && node.id) {
      name = node.id.name;

    } else if (node.type === 'MethodDefinition') {
      const k = node.key;
      name = k.type === 'Identifier' ? k.name : String(k.value ?? '');
      if (node.kind === 'get' || node.kind === 'set') name = `${node.kind} ${name}`;
      if (node.static) name = `static ${name}`;

    } else if (isFn && parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') {
      name = parent.id.name;

    } else if (isFn && parent?.type === 'Property' && parent.key?.type === 'Identifier') {
      name = parent.key.name;

    } else if (
      isFn &&
      parent?.type === 'AssignmentExpression' &&
      parent.left?.type === 'MemberExpression' &&
      parent.left.property?.type === 'Identifier'
    ) {
      name = parent.left.property.name;

    } else if (
      isFn &&
      parent?.type === 'CallExpression' &&
      parent.callee?.type === 'MemberExpression' &&
      HTTP_METHODS.has(parent.callee.property?.name) &&
      parent.arguments.at(-1) === node
    ) {
      const method  = parent.callee.property.name.toUpperCase();
      const pathArg = parent.arguments.find(a => a.type === 'Literal' && typeof a.value === 'string');
      name = pathArg ? `${method} ${pathArg.value}` : method;
    }

    if (name && node.loc) {
      fns.push({ name, startLine: node.loc.start.line, endLine: node.loc.end.line });
    }

    for (const key of Object.keys(node)) {
      if (SKIP_AST_KEYS.has(key)) continue;
      const val = node[key];
      if (Array.isArray(val))                              val.forEach(c => walk(c, node));
      else if (val && typeof val === 'object' && val.type) walk(val, node);
    }
  }

  walk(ast, null);
  return fns;
}
