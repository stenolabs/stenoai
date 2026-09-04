import tempfile
import unittest
from pathlib import Path

from scripts.verify_ollama_gpu_bundle import (
    ollama_gpu_family,
    should_prune_ollama_gpu_path,
    verify_ollama_gpu_bundle,
)


class OllamaGpuPathTests(unittest.TestCase):
    def test_recognizes_supported_gpu_directories(self):
        self.assertEqual(ollama_gpu_family("lib/ollama/cuda_v12/libggml-cuda.so"), "cuda")
        self.assertEqual(ollama_gpu_family("lib/ollama/rocm/libggml-hip.so"), "rocm")
        self.assertEqual(ollama_gpu_family("lib/ollama/vulkan/libggml-vulkan.so"), "vulkan")

    def test_does_not_treat_cpu_or_similar_names_as_gpu_payloads(self):
        self.assertIsNone(ollama_gpu_family("lib/ollama/libggml-cpu.so"))
        self.assertIsNone(ollama_gpu_family("lib/ollama/vulkanish/library.so"))

    def test_windows_prunes_gpu_payloads_only(self):
        self.assertTrue(
            should_prune_ollama_gpu_path(
                "lib\\ollama\\cuda_v13\\ggml-cuda.dll",
                platform="win32",
            )
        )
        self.assertFalse(
            should_prune_ollama_gpu_path("lib/ollama/ggml-cpu.dll", platform="win32")
        )

    def test_linux_and_macos_preserve_gpu_payloads(self):
        path = "lib/ollama/cuda_v12/libggml-cuda.so"
        self.assertFalse(should_prune_ollama_gpu_path(path, platform="linux"))
        self.assertFalse(should_prune_ollama_gpu_path(path, platform="darwin"))


class OllamaGpuBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.source = root / "source"
        self.bundle = root / "bundle"
        self.target = self.bundle / "_internal" / "ollama"

        for relative_path in (
            "lib/ollama/cuda_v12/libggml-cuda.so",
            "lib/ollama/vulkan/libggml-vulkan.so",
        ):
            source_path = self.source / relative_path
            target_path = self.target / relative_path
            source_path.parent.mkdir(parents=True, exist_ok=True)
            target_path.parent.mkdir(parents=True, exist_ok=True)
            source_path.write_bytes(b"source payload")
            target_path.write_bytes(b"bundled payload")

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_accepts_every_gpu_payload_offered_by_source(self):
        result = verify_ollama_gpu_bundle(self.source, self.bundle)

        self.assertEqual(result["families"], ("cuda", "vulkan"))
        self.assertEqual(result["payload_count"], 2)
        self.assertGreater(result["gpu_logical_bytes"], 0)

    def test_accepts_valid_relative_gpu_symlink(self):
        cuda_dir = self.source / "lib/ollama/cuda_v12"
        source_versioned = cuda_dir / "libggml-cuda.so.0"
        source_versioned.write_bytes(b"source versioned payload")
        (cuda_dir / "libggml-cuda.so.link").symlink_to(source_versioned.name)

        target_cuda_dir = self.target / "lib/ollama/cuda_v12"
        target_versioned = target_cuda_dir / "libggml-cuda.so.0"
        target_versioned.write_bytes(b"bundled versioned payload")
        (target_cuda_dir / "libggml-cuda.so.link").symlink_to(target_versioned.name)

        result = verify_ollama_gpu_bundle(self.source, self.bundle)

        self.assertEqual(result["payload_count"], 4)

    def test_rejects_missing_gpu_payload(self):
        (self.target / "lib/ollama/vulkan/libggml-vulkan.so").unlink()

        with self.assertRaisesRegex(FileNotFoundError, "vulkan/libggml-vulkan.so"):
            verify_ollama_gpu_bundle(self.source, self.bundle)

    def test_rejects_empty_gpu_payload(self):
        (self.target / "lib/ollama/cuda_v12/libggml-cuda.so").write_bytes(b"")

        with self.assertRaisesRegex(FileNotFoundError, "empty"):
            verify_ollama_gpu_bundle(self.source, self.bundle)

    def test_rejects_broken_gpu_symlink(self):
        target = self.target / "lib/ollama/cuda_v12/libggml-cuda.so"
        target.unlink()
        target.symlink_to("missing.so")

        with self.assertRaisesRegex(FileNotFoundError, "missing or broken"):
            verify_ollama_gpu_bundle(self.source, self.bundle)

    def test_rejects_source_without_required_cuda_payload(self):
        cuda_source = self.source / "lib/ollama/cuda_v12/libggml-cuda.so"
        cuda_source.unlink()

        with self.assertRaisesRegex(FileNotFoundError, "required GPU families: cuda"):
            verify_ollama_gpu_bundle(self.source, self.bundle)

    def test_rejects_cuda_directory_without_cuda_backend_library(self):
        cuda_source = self.source / "lib/ollama/cuda_v12/libggml-cuda.so"
        cuda_source.rename(cuda_source.with_name("README"))

        with self.assertRaisesRegex(FileNotFoundError, "required GPU families: cuda"):
            verify_ollama_gpu_bundle(self.source, self.bundle)


if __name__ == "__main__":
    unittest.main()
