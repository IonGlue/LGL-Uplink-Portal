#!/usr/bin/env node
/**
 * dump.js — Capture ATEM init dump from a real device to a .data file.
 *
 * Adapted from nrkno/sofie-atem-connection (MIT license).
 * Source: https://github.com/nrkno/sofie-atem-connection/blob/master/src/__tests__/connection/dump.js
 *
 * The .data format (newline-separated hex payloads) is directly parseable by
 * parse_atem_commands.py and debug_pvw_diff.py.
 *
 * Usage:
 *   npm install atem-connection        # one-time
 *   node dump.js <atem-ip> <output-name>
 *   node dump.js 192.168.1.100 tvshd-myfirmware
 *   # Creates: tvshd-myfirmware.data
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Atem } = require('atem-connection')

const ip = process.argv[2]
const name = process.argv[3]

if (!ip || !name) {
	console.error('Usage: node dump.js <atem-ip> <output-name>')
	process.exit(1)
}

const atem = new Atem()

const packets = []

// Intercept raw payloads before parsing
const origParse = atem._socket._parseCommands.bind(atem._socket)
atem._socket._parseCommands = (buffer) => {
	packets.push(buffer.toString('hex'))
	return origParse(buffer)
}

atem.on('disconnected', () => {
	console.log('Disconnected')
})

atem.on('connected', () => {
	console.log('Connected, waiting for init complete...')
})

atem.on('stateChanged', (state, pathKeys) => {
	if (pathKeys.includes('info.version')) {
		console.log(`Version: ${state.info.version}`)
	}
})

// Wait for init complete command (signals end of state dump)
const origEmit = atem.emit.bind(atem)
atem.emit = (event, ...args) => {
	if (event === 'connected') {
		// Give it a moment to finish the init dump
		setTimeout(() => {
			const fs = require('fs')
			const outFile = `${name}.data`
			fs.writeFileSync(outFile, packets.join('\n') + '\n')
			console.log(`Saved ${packets.length} packets to ${outFile}`)
			process.exit(0)
		}, 2000)
	}
	return origEmit(event, ...args)
}

console.log(`Connecting to ${ip}...`)
atem.connect(ip)
