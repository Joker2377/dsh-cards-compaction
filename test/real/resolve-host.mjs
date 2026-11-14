/**
 * Module resolve hook for the real-host test layer: a bare specifier that does
 * not resolve from this repo resolves from DSH_HOST_NODE_MODULES instead, a
 * host node_modules directory (for example extracted from the installed App's
 * app.asar). Nothing is installed into this repo.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const hostParent = process.env.DSH_HOST_NODE_MODULES
	? pathToFileURL(join(process.env.DSH_HOST_NODE_MODULES, '..', 'resolve-anchor.js')).href
	: undefined

export async function resolve(specifier, context, next) {
	try {
		return await next(specifier, context)
	} catch (error) {
		const bare = !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':')
		if (!hostParent || !bare || error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
		return next(specifier, { ...context, parentURL: hostParent })
	}
}
