// node 的模块解析钩子：鸿蒙工程里 .ts 之间的导入不写扩展名（构建要求如此），
// node 找不到时补上 .ts 再试一次。由 register.mjs 注册。
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (!relative || specifier.endsWith('.ts') || err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    return nextResolve(`${specifier}.ts`, context);
  }
}
