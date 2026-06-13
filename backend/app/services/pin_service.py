"""Qiskit Metal pin extraction."""
from __future__ import annotations

import logging
import math

from app.core.registry_cache import registry_cache
from app.core.editor_models import ComponentPins, PinHint, PinSpec

log = logging.getLogger(__name__)


def _make_default_connection_pads(cls: type) -> dict:
    default_opts = getattr(cls, "default_options", {})
    if "_default_connection_pads" not in default_opts:
        return {}
    base = dict(default_opts["_default_connection_pads"])
    if "connector_location" in base:
        base.pop("connector_location", None)
        return {
            "readout": {**base, "connector_location": "0"},
            "bus_01":  {**base, "connector_location": "180"},
            "bus_02":  {**base, "connector_location": "90"},
        }
    if "loc_W" in base and "loc_H" in base:
        return {
            "a": {**base, "loc_W": "+1", "loc_H": "+1"},
            "b": {**base, "loc_W": "-1", "loc_H": "+1"},
            "c": {**base, "loc_W": "+1", "loc_H": "-1"},
            "d": {**base, "loc_W": "-1", "loc_H": "-1"},
        }
    return {name: dict(base) for name in ("a", "b", "c", "d")}


class PinService:
    @staticmethod
    def _cache_key(component_id: str) -> str:
        return f"pins:{component_id}"

    def extract_pins(self, component_id: str) -> ComponentPins:
        from app.services.component_registry import component_registry_service
        summary = component_registry_service.get_component(component_id)
        if summary is None:
            log.warning("Pins requested for unknown component %s. Returning empty pins.", component_id)
            return ComponentPins(id=component_id, pins=[])
        try:
            return self._extract_via_instantiation(component_id, summary.module)
        except Exception as exc:
            log.warning("Pin extraction failed for %s: %s", component_id, exc)
            return ComponentPins(id=component_id, pins=[])

    def _extract_via_instantiation(self, component_id: str, module_path: str) -> ComponentPins:
        import importlib
        from qiskit_metal import designs as qm_designs

        module = importlib.import_module(module_path)
        cls = getattr(module, component_id)

        design = qm_designs.DesignPlanar(enable_renderers=False)
        design.overwrite_enabled = True

        options: dict = {}
        pad_cfg = _make_default_connection_pads(cls)
        if pad_cfg:
            options["connection_pads"] = pad_cfg

        try:
            cls(design, "_pin_probe", options=options)
        except Exception as exc:
            log.warning("Could not instantiate %s: %s", component_id, exc)
            return ComponentPins(id=component_id, pins=[])

        try:
            design.rebuild()
        except Exception:
            pass

        comp = design.components["_pin_probe"]
        pins: list[PinSpec] = []

        if comp is not None:
            for pin_name, pin_data in comp.pins.items():
                middle = pin_data.get("middle", [0.0, 0.0])
                normal = pin_data.get("normal", [0.0, 1.0])
                angle = math.degrees(math.atan2(float(normal[1]), float(normal[0])))
                pins.append(PinSpec(
                    name=pin_name, direction="io",
                    hint=PinHint(x=float(middle[0]) * 1000.0, y=float(middle[1]) * 1000.0, angle=angle),
                ))

        if not pins and pad_cfg:
            for pad_name in pad_cfg:
                pins.append(PinSpec(name=pad_name, direction="io", hint=PinHint(x=0.0, y=0.0, angle=0.0)))

        return ComponentPins(id=component_id, pins=pins)

    def get_pins(self, component_id: str) -> ComponentPins:
        return registry_cache.get_or_set(self._cache_key(component_id), lambda: self.extract_pins(component_id))


pin_service = PinService()
