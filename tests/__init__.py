
import os

# Default unit tests to non-Apple path unless explicitly un-disabled by a test.
os.environ.setdefault("STENOAI_DISABLE_APPLE_LM", "1")