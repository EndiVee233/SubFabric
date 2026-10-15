"""Device/format regressions without loading a GPU or downloading weights."""
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from asr import vibevoice as worker

NS = types.SimpleNamespace

class Layer:
    def __init__(self):
        self.weight = NS(quant_state=NS(quant_type="nf4"))

class Model:
    hf_device_map = {"": "cuda:0"}
    is_loaded_in_4bit = True
    def __init__(self):
        self.param = NS(device=NS(type="cuda"))
        self.buffer = NS(device=NS(type="cuda"))
        self.layer = Layer()
    def parameters(self): return [self.param]
    def buffers(self): return [self.buffer]
    def modules(self): return [self.layer]
    def eval(self): return self

class VibeVoiceTests(unittest.TestCase):
    def test_timestamps_overlap_and_roles(self):
        rows = worker.normalize_segments([
            {"Start": .2, "End": 1.4, "Speaker": "A", "Content": "one"},
            {"Start": 1., "End": 2., "Speaker": "B", "Content": "two"},
            {"Start": 2., "End": 2.8, "Speaker": "A", "Content": "three"},
        ], 3.)
        self.assertEqual([r['speaker'] for r in rows], [0, 1, 0])
        self.assertEqual(rows[1]['start'], 1.)
        self.assertTrue(all(r['words'] == [] for r in rows))
        for bad in [None, float('nan'), float('inf'), 9., -2.]:
            with self.assertRaises(RuntimeError):
                worker.normalize_segments([{'Start': bad, 'End': 2, 'Content': 'bad'}], 3.)
        self.assertEqual(worker.normalize_segments('not JSON', 3.), [])

    def test_decode_one_sequence_and_reject_malformed(self):
        class Generated:
            ndim = 2
            shape = (1, 4)
            def __getitem__(self, key):
                assert key == 0
                return [1, 2, 3, 4]
        def decode(tokens, return_format):
            self.assertEqual(tokens, [1, 2, 3, 4])
            self.assertEqual(return_format, 'parsed')
            return [{'Start': 0, 'End': 1, 'Content': 'ok'}]
        self.assertEqual(len(worker.decode_transcription(NS(decode=decode), Generated())), 1)
        with self.assertRaises(RuntimeError):
            worker.decode_transcription(NS(decode=lambda *a, **k: 'broken'), Generated())

    def test_cuda_loading_and_fail_closed(self):
        config = {'quantization_config': {'load_in_4bit': True, 'quant_method': 'bitsandbytes',
            'bnb_4bit_quant_type': 'nf4', 'llm_int8_skip_modules': ['lm_head']}}
        metadata = {'bits': 4, 'quant_type': 'nf4', 'quantization_method': 'bitsandbytes'}
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            (root/'config.json').write_text(json.dumps(config))
            (root/'quantization_metadata.json').write_text(json.dumps(metadata))
            loaded = []
            model = Model()
            def from_pretrained(*args, **kwargs):
                loaded.append(kwargs)
                return model
            cuda = NS(is_available=lambda: True, get_device_properties=lambda _: NS(total_memory=8*1024**3),
                mem_get_info=lambda _: (7*1024**3, 8*1024**3), empty_cache=lambda: None,
                memory_allocated=lambda _: 0, memory_reserved=lambda _: 0)
            torch = NS(cuda=cuda, device=lambda s: s, bfloat16='bf16')
            transformers = NS(AutoProcessor=NS(from_pretrained=lambda *a, **k: object()),
                AutoConfig=NS(from_pretrained=lambda *a, **k: NS()),
                VibeVoiceAsrForConditionalGeneration=NS(from_pretrained=from_pretrained))
            with patch.dict(sys.modules, {'torch': torch, 'transformers': transformers,
                    'bitsandbytes': NS(nn=NS(Linear4bit=Layer))}), patch.object(worker, 'emit'):
                worker.load_processor_and_model(folder)
                self.assertEqual(loaded[0]['device_map'], {'': 'cuda:0'})
                self.assertTrue(loaded[0]['local_files_only'])
                self.assertFalse(loaded[0]['trust_remote_code'])
                self.assertIn('model.acoustic_tokenizer_encoder', loaded[0]['config'].quantization_config['llm_int8_skip_modules'])
                cases = [lambda: setattr(model.param.device, 'type', 'cpu'),
                    lambda: setattr(model.buffer.device, 'type', 'cpu'),
                    lambda: setattr(model, 'hf_device_map', {'': 'disk'}),
                    lambda: setattr(model.layer.weight, 'quant_state', None),
                    lambda: setattr(model, 'is_loaded_in_4bit', False),
                    lambda: setattr(model.layer, '_hf_hook', NS(offload=True))]
                for mutate in cases:
                    model = Model()
                    mutate()
                    with self.assertRaises(RuntimeError): worker.load_processor_and_model(folder)
                count = len(loaded)
                cuda.is_available = lambda: False
                with self.assertRaises(RuntimeError): worker.load_processor_and_model(folder)
                self.assertEqual(len(loaded), count, 'CPU must fail before model loading')

unittest.main()
