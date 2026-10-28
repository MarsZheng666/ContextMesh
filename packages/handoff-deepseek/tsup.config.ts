import { defineConfig } from 'tsup'
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node24',
    dts: true,
    sourcemap: true,
    clean: false,
    splitting: false,
  },
  {
    entry: { client: 'src/client/index.tsx' },
    format: ['cjs'],
    target: 'es2022',
    platform: 'browser',
    outExtension: () => ({ js: '.js' }),
    banner: {
      js: 'window.__ModuleLoader__.load({id:"dsh-contextmesh-handoff",factory:(require)=>{var module={exports:{}};var exports=module.exports;',
    },
    footer: { js: 'return module.exports;}});' },
    external: ['react', 'react/jsx-runtime'],
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
  },
])
