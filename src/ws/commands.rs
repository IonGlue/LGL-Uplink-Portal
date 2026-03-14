use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// All valid commands that can be sent to a device
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum DeviceCommand {
    Start,
    Stop,
    SetBitrateRange {
        min_kbps: u32,
        max_kbps: u32,
    },
    SetPipeline {
        variant: PipelineVariant,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PipelineVariant {
    H264V4l2Usb,
    H265V4l2Usb,
    H264Qsv,
}

impl DeviceCommand {
    pub fn validate(&self) -> Result<()> {
        match self {
            DeviceCommand::SetBitrateRange { min_kbps, max_kbps } => {
                if min_kbps > max_kbps {
                    return Err(AppError::InvalidCommand(
                        "min_kbps must be <= max_kbps".to_string(),
                    ));
                }
                if *max_kbps > 100_000 {
                    return Err(AppError::InvalidCommand(
                        "max_kbps exceeds 100000".to_string(),
                    ));
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Serialize to the wire format the device expects
    pub fn to_wire_json(&self) -> serde_json::Value {
        let mut val = serde_json::to_value(self).unwrap_or_default();
        val["msg_type"] = "command".into();
        val
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bitrate_range_validation() {
        let cmd = DeviceCommand::SetBitrateRange { min_kbps: 5000, max_kbps: 2000 };
        assert!(cmd.validate().is_err());

        let cmd = DeviceCommand::SetBitrateRange { min_kbps: 2000, max_kbps: 200_000 };
        assert!(cmd.validate().is_err());

        let cmd = DeviceCommand::SetBitrateRange { min_kbps: 2000, max_kbps: 8000 };
        assert!(cmd.validate().is_ok());
    }

    #[test]
    fn test_wire_format_has_msg_type() {
        let cmd = DeviceCommand::Start;
        let json = cmd.to_wire_json();
        assert_eq!(json["msg_type"], "command");
        assert_eq!(json["cmd"], "start");
    }
}
