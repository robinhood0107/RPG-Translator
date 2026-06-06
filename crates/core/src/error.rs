use std::fmt;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    UnsupportedPhaseOperation { phase: String },
}

impl Error {
    #[must_use]
    pub fn unsupported_phase_operation(phase: impl Into<String>) -> Self {
        Self::UnsupportedPhaseOperation {
            phase: phase.into(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedPhaseOperation { phase } => {
                write!(f, "unsupported operation in phase: {phase}")
            }
        }
    }
}

impl std::error::Error for Error {}
