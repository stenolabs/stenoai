# Synthetic Swift meeting package

`swift-meeting-v1.stenomeeting` was created on 2026-09-12 by the unmodified
`StenoExchange.MeetingTransferArchiveWriter` from `stenolabs/steno-macos`,
commit `979d62e49e401e654763d0210c77a8ceee3a5326`. Its source files were compiled
directly in an isolated local validation directory. No application library or
machine-learning model was opened.

The package contains invented notes and transcript text, a synthetic title,
explicit `de-DE` locale provenance, and 80 generated Float32 samples at 8 kHz
in a mono CAF written by `AVAudioFile`. It contains no recording or personal
information. Meeting identity is `00000000-0000-7000-8000-000000000031`.

Archive SHA-256:
`feda9e9286dc489762bcf13fc7d66b7b40a7a385bc0ef59fb63bcf093d5a5b91`

Writer source SHA-256:
`7a64290aa427208e4e25de45d25bd6321bf8d477fef244be7e3a5fe63217444f`

Reader source SHA-256:
`3950390504607a3a33aab71663742a05af206377d4140d1827309089c951aede`

The Node codec imported and re-exported this fixture. The original Swift
`MeetingTransferArchiveReader` accepted the resulting archive, including
its content digest, transcript, locale and audio metadata. The codec test
keeps the original Swift-written bytes as an independent format fixture.
