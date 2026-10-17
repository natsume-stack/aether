//! Runtime catalog fallback values.

use crate::*;

pub(crate) fn unavailable_runtime() -> Value {
    json!({"phase":"stopped","percent":0,"message":"运行时未连接","updatedAt":"","cpuPercent":null,"memoryBytes":null,"uptimeMs":null,"processCount":0,"rooms":[]})
}
