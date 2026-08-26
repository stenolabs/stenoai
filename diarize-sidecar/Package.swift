// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "diarize-sidecar",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.15.2"),
    ],
    targets: [
        .target(
            name: "DiarizationCore",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
            ],
            path: "Sources/DiarizationCore"
        ),
        .executableTarget(
            name: "diarize-sidecar",
            dependencies: [
                "DiarizationCore",
                .product(name: "FluidAudio", package: "FluidAudio"),
            ],
            path: "Sources",
            exclude: ["DiarizationCore"]
        ),
        .testTarget(
            name: "DiarizationCoreTests",
            dependencies: ["DiarizationCore"],
            path: "Tests/DiarizationCoreTests"
        ),
    ]
)
