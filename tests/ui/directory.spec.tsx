import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import {
  DirectoryBrowserModel,
  type DirectoryListing,
} from '../../packages/handoff-deepseek/src/client/directory.js'
import { DirectoryBrowserView } from '../../packages/handoff-deepseek/src/client/view.js'
import {
  en,
  zh,
  type Key,
} from '../../packages/handoff-deepseek/src/client/locales.js'
const listing = (path: string): DirectoryListing => ({
  path,
  home: '/home/host',
  crumbs: [{ name: '/', path: '/', hidden: false }],
  entries: [
    { name: 'repo', path: path + '/repo', hidden: false },
    { name: '.private', path: path + '/.private', hidden: true },
  ],
  truncated: false,
})
it('browses the injected DSH host and keeps a later directory when an older read resolves late', async () => {
  let finish!: (value: DirectoryListing) => void
  const list = vi.fn((path?: string, _signal?: AbortSignal) =>
      path === '/old'
        ? new Promise<DirectoryListing>((resolve) => {
            finish = resolve
          })
        : Promise.resolve(listing(path ?? '/host')),
    ),
    browser = new DirectoryBrowserModel(list)
  const old = browser.navigate('/old')
  await browser.navigate('/server/repository')
  finish(listing('/old'))
  await old
  expect(browser.getSnapshot()).toMatchObject({
    loading: false,
    failed: false,
    listing: { path: '/server/repository' },
  })
  expect(list.mock.calls[0]?.[1]?.aborted).toBe(true)
  expect(list.mock.calls.map((call) => call[0])).toEqual([
    '/old',
    '/server/repository',
  ])
  browser.close()
})
it('does not replace a saved listing on failure or accept a result after closing', async () => {
  let finish!: (value: DirectoryListing) => void
  const list = vi.fn((path?: string, _signal?: AbortSignal) =>
      path === '/denied'
        ? Promise.reject(new Error('permission denied'))
        : path === '/pending'
          ? new Promise<DirectoryListing>((resolve) => {
              finish = resolve
            })
          : Promise.resolve(listing('/host')),
    ),
    browser = new DirectoryBrowserModel(list)
  await browser.navigate()
  await browser.navigate('/denied')
  expect(browser.getSnapshot()).toMatchObject({
    failed: true,
    loading: false,
    listing: { path: '/host' },
  })
  const pending = browser.navigate('/pending')
  browser.close()
  finish(listing('/pending'))
  await pending
  expect(browser.getSnapshot().listing?.path).toBe('/host')
  await browser.start('/reopened')
  expect(browser.getSnapshot()).toMatchObject({
    failed: false,
    loading: false,
    listing: { path: '/host' },
  })
  browser.close()
})
for (const locale of [en, zh])
  it(`renders host folders and selection controls in ${locale.selectDirectory}`, () => {
    const props = {
      state: { loading: false, failed: false, listing: listing('/server') },
      device: 'Server device',
      path: '/server',
      setPath: () => {},
      hidden: false,
      setHidden: () => {},
      navigate: () => {},
      pick: () => {},
      cancel: () => {},
      t: (key: string) => locale[key as Key],
    }
    const html = renderToStaticMarkup(<DirectoryBrowserView {...props} />)
    expect(html).toContain('Server device')
    expect(html).toContain('repo')
    expect(html).not.toContain('.private')
    expect(html).toContain(locale.useDirectory)
    expect(html).toContain(locale.directoryHome)
    expect(html).toContain(locale.cancelSetup)
    const failed = renderToStaticMarkup(
      <DirectoryBrowserView
        {...props}
        state={{ ...props.state, failed: true }}
      />,
    )
    expect(failed).toContain(locale.DIRECTORY_BROWSE_FAILED)
    expect(failed).not.toContain('class="cm-directory-entry"')
  })
