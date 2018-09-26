import { existsSync, writeFileSync } from 'fs'
import http from 'http'
import { resolve } from 'path'
import { remove } from 'fs-extra'
import serveStatic from 'serve-static'
import finalhandler from 'finalhandler'
import { Cluster, getPort, loadFixture, rp, listPaths, equalOrStartsWith, waitUntil } from '../utils'

let port
const url = route => 'http://localhost:' + port + route
const rootDir = resolve(__dirname, '..', 'fixtures/basic')
const distDir = resolve(rootDir, '.nuxt-cluster')

let server = null
let generator = null
let pathsBefore
let changedFileName

describe('cluster generate', () => {
  beforeAll(async () => {
    const config = await loadFixture('basic', { generate: { dir: distDir } })

    const master = new Cluster.Master(config, {
      adjustLogLevel: -6,
      workerCount: 2,
      setup: {
        exec: resolve(__dirname, '..', 'utils', 'cluster.worker.js')
      }
    })

    generator = master.generator
    generator.builder.build = jest.fn()
    const nuxt = generator.nuxt

    pathsBefore = listPaths(nuxt.options.rootDir)

    let ready = false
    // Make sure our check for changed files is really working
    changedFileName = resolve(nuxt.options.generate.dir, '..', '.nuxt-cluster-changed')
    master.hook('done', (info) => {
      writeFileSync(changedFileName, '')
      expect(info.errors.length).toBe(1)
      ready = true
    })

    await master.run({ build: true })
    await waitUntil(() => ready)

    const serve = serveStatic(distDir)
    server = http.createServer((req, res) => {
      serve(req, res, finalhandler(req, res))
    })

    port = await getPort()
    server.listen(port)
  })

  test('Check builder', () => {
    expect(generator.builder.isStatic).toBe(true)
    expect(generator.builder.build).toHaveBeenCalledTimes(1)
  })

  test('Check ready hook called', () => {
    expect(generator.nuxt.__hook_ready_called__).toBe(true)
  })

  test('Check changed files', () => {
    // When generating Nuxt we only expect files to change
    // within nuxt.options.generate.dir, but also allow other
    // .nuxt dirs for when tests are runInBand
    const allowChangesDir = resolve(generator.nuxt.options.generate.dir, '..', '.nuxt')

    let changedFileFound = false
    const paths = listPaths(generator.nuxt.options.rootDir, pathsBefore)
    paths.forEach((item) => {
      if (item.path === changedFileName) {
        changedFileFound = true
      } else {
        expect(equalOrStartsWith(allowChangesDir, item.path)).toBe(true)
      }
    })
    expect(changedFileFound).toBe(true)
  })

  test('Format errors', () => {
    const error = generator._formatErrors([
      { type: 'handled', route: '/h1', error: 'page not found' },
      { type: 'unhandled', route: '/h2', error: { stack: 'unhandled error stack' } }
    ])
    expect(error).toMatch(' GEN ERR ')
    expect(error).toMatch(' /h1')
    expect(error).toMatch(' /h2')
    expect(error).toMatch('"page not found"')
    expect(error).toMatch('unhandled error stack')
  })

  test('/stateless', async () => {
    const window = await generator.nuxt.renderAndGetWindow(url('/stateless'))
    const html = window.document.body.innerHTML
    expect(html.includes('<h1>My component!</h1>')).toBe(true)
  })

  test('/store-module', async () => {
    const window = await generator.nuxt.renderAndGetWindow(url('/store-module'))
    const html = window.document.body.innerHTML
    expect(html.includes('<h1>mutated</h1>')).toBe(true)
  })

  test('/css', async () => {
    const window = await generator.nuxt.renderAndGetWindow(url('/css'))

    const headHtml = window.document.head.innerHTML
    expect(headHtml.includes('.red{color:red')).toBe(true)

    const element = window.document.querySelector('.red')
    expect(element).not.toBe(null)
    expect(element.textContent).toBe('This is red')
    expect(element.className).toBe('red')
    // t.is(window.getComputedStyle(element), 'red')
  })

  test('/stateful', async () => {
    const window = await generator.nuxt.renderAndGetWindow(url('/stateful'))
    const html = window.document.body.innerHTML
    expect(html.includes('<div><p>The answer is 42</p></div>')).toBe(true)
  })

  test('/head', async () => {
    const window = await generator.nuxt.renderAndGetWindow(url('/head'))
    const html = window.document.body.innerHTML
    const metas = window.document.getElementsByTagName('meta')
    expect(window.document.title).toBe('My title - Nuxt.js')
    expect(metas[0].getAttribute('content')).toBe('my meta')
    expect(html.includes('<div><h1>I can haz meta tags</h1></div>')).toBe(true)
  })

  test('/async-data', async () => {
    const window = await generator.nuxt.renderAndGetWindow(url('/async-data'))
    const html = window.document.body.innerHTML
    expect(html.includes('<p>Nuxt.js</p>')).toBe(true)
  })

  test('/users/1/index.html', async () => {
    const html = await rp(url('/users/1/index.html'))
    expect(html.includes('<h1>User: 1</h1>')).toBe(true)
    expect(
      existsSync(resolve(distDir, 'users/1/index.html'))
    ).toBe(true)
    expect(existsSync(resolve(distDir, 'users/1.html'))).toBe(false)
  })

  test('/users/2', async () => {
    const html = await rp(url('/users/2'))
    expect(html.includes('<h1>User: 2</h1>')).toBe(true)
  })

  test('/users/3 (payload given)', async () => {
    const html = await rp(url('/users/3'))
    expect(html.includes('<h1>User: 3000</h1>')).toBe(true)
  })

  test('/users/4 -> Not found', async () => {
    await expect(rp(url('/users/4'))).rejects.toMatchObject({
      statusCode: 404,
      response: {
        body: expect.stringContaining('Cannot GET /users/4')
      }
    })
  })

  test('/validate should not be server-rendered', async () => {
    const html = await rp(url('/validate'))
    expect(html.includes('<div id="__nuxt"></div>')).toBe(true)
    expect(html.includes('serverRendered:!1')).toBe(true)
  })

  test('/validate -> should display a 404', async () => {
    const window = await generator.nuxt.renderAndGetWindow(url('/validate'))
    const html = window.document.body.innerHTML
    expect(html.includes('This page could not be found')).toBe(true)
  })

  test('/validate?valid=true', async () => {
    const window = await generator.nuxt.renderAndGetWindow(url('/validate?valid=true'))
    const html = window.document.body.innerHTML
    expect(html.includes('I am valid</h1>')).toBe(true)
  })

  test('/redirect should not be server-rendered', async () => {
    const html = await rp(url('/redirect'))
    expect(html.includes('<div id="__nuxt"></div>')).toBe(true)
    expect(html.includes('serverRendered:!1')).toBe(true)
  })

  test('/redirect -> check redirected source', async () => {
    const window = await generator.nuxt.renderAndGetWindow(url('/redirect'))
    const html = window.document.body.innerHTML
    expect(html.includes('<h1>Index page</h1>')).toBe(true)
  })

  test('/users/1 not found', async () => {
    await remove(resolve(distDir, 'users'))
    await expect(rp(url('/users/1'))).rejects.toMatchObject({
      statusCode: 404,
      response: {
        body: expect.stringContaining('Cannot GET /users/1')
      }
    })
  })

  test('nuxt re-generating with no subfolders', async () => {
    generator.nuxt.options.generate.subFolders = false
    await expect(generator.generate({ build: false })).resolves.toBeTruthy()
  })

  test('/users/1.html', async () => {
    const html = await rp(url('/users/1.html'))
    expect(html.includes('<h1>User: 1</h1>')).toBe(true)
    expect(existsSync(resolve(distDir, 'users/1.html'))).toBe(true)
    expect(
      existsSync(resolve(distDir, 'users/1/index.html'))
    ).toBe(false)
  })

  test('/-ignored', async () => {
    await expect(rp(url('/-ignored'))).rejects.toMatchObject({
      statusCode: 404,
      response: {
        body: expect.stringContaining('Cannot GET /-ignored')
      }
    })
  })

  test('/ignored.test', async () => {
    await expect(rp(url('/ignored.test'))).rejects.toMatchObject({
      statusCode: 404,
      response: {
        body: expect.stringContaining('Cannot GET /ignored.test')
      }
    })
  })

  // Close server and ask nuxt to stop listening to file changes
  afterAll(async () => {
    await server.close()
  })
})
