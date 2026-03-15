import { AppError } from '../error.js'

export interface BondPath {
  interface: string
  priority?: number
}

export interface DeviceCommand {
  cmd: string
  // SetBitrateRange
  min_kbps?: number
  max_kbps?: number
  // SetPipeline
  variant?: string
  // SetConfig
  capture_device?: string
  pipeline?: string
  resolution?: string
  framerate?: string
  bitrate_min_kbps?: number
  bitrate_max_kbps?: number
  srt_host?: string
  srt_port?: number
  srt_latency_ms?: number
  srt_passphrase?: string
  bond_enabled?: boolean
  bond_relay_host?: string
  bond_relay_port?: number
  bond_local_port?: number
  bond_keepalive_ms?: number
  bond_paths?: BondPath[]
}

const VALID_CMDS = ['start', 'stop', 'restart', 'set_bitrate_range', 'set_pipeline', 'set_config']
const VALID_FRAMERATES = ['23.976', '23.98', '24', '25', '29.97', '30', '50', '59.94', '60']
const VALID_PIPELINES = ['h264_v4l2_usb', 'h265_v4l2_usb', 'h264_qsv']

export function validateCommand(cmd: DeviceCommand) {
  if (!VALID_CMDS.includes(cmd.cmd)) {
    throw AppError.invalidCommand(`unknown command '${cmd.cmd}'`)
  }

  if (cmd.cmd === 'set_bitrate_range') {
    if (cmd.min_kbps == null || cmd.max_kbps == null) {
      throw AppError.invalidCommand('min_kbps and max_kbps are required')
    }
    if (cmd.min_kbps > cmd.max_kbps) {
      throw AppError.invalidCommand('min_kbps must be <= max_kbps')
    }
    if (cmd.max_kbps > 100_000) {
      throw AppError.invalidCommand('max_kbps exceeds 100000')
    }
  }

  if (cmd.cmd === 'set_config') {
    if (cmd.bitrate_min_kbps != null && cmd.bitrate_max_kbps != null) {
      if (cmd.bitrate_min_kbps > cmd.bitrate_max_kbps) {
        throw AppError.invalidCommand('min_kbps must be <= max_kbps')
      }
      if (cmd.bitrate_max_kbps > 100_000) {
        throw AppError.invalidCommand('max_kbps exceeds 100000')
      }
    }
    if (cmd.framerate != null && !VALID_FRAMERATES.includes(cmd.framerate)) {
      throw AppError.invalidCommand(
        `framerate '${cmd.framerate}' must be a SMPTE standard rate: ${VALID_FRAMERATES.join(', ')}`,
      )
    }
    if (cmd.srt_passphrase != null && cmd.srt_passphrase !== '') {
      if (cmd.srt_passphrase.length < 10 || cmd.srt_passphrase.length > 79) {
        throw AppError.invalidCommand('srt_passphrase must be 10-79 characters (or empty to clear)')
      }
    }
    if (cmd.resolution != null && !cmd.resolution.includes('x')) {
      throw AppError.invalidCommand('resolution must be WxH')
    }
    if (cmd.pipeline != null && !VALID_PIPELINES.includes(cmd.pipeline)) {
      throw AppError.invalidCommand(`unknown pipeline '${cmd.pipeline}'`)
    }
    if (cmd.srt_port != null && cmd.srt_port === 0) {
      throw AppError.invalidCommand('srt_port must be non-zero')
    }
    if (cmd.bond_relay_port != null && cmd.bond_relay_port === 0) {
      throw AppError.invalidCommand('bond_relay_port must be non-zero')
    }
    if (cmd.bond_paths != null) {
      if (cmd.bond_paths.length === 0) {
        throw AppError.invalidCommand('bond_paths must not be empty')
      }
      for (const p of cmd.bond_paths) {
        if (!p.interface) {
          throw AppError.invalidCommand('bond path interface must not be empty')
        }
      }
    }
  }
}

export function toWireJson(cmd: DeviceCommand): Record<string, unknown> {
  return { ...cmd, msg_type: 'command' }
}
