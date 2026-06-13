"""Qiskit Metal parameter metadata extraction."""
from __future__ import annotations

import logging
import re

from app.core.registry_cache import registry_cache
from app.core.editor_models import ComponentMetadata, ParameterSpec

log = logging.getLogger(__name__)


class MetadataService:
    """Extract parameter schemas from QComponent defaults."""

    @staticmethod
    def _cache_key(component_id: str) -> str:
        return f"metadata:{component_id}"

    def extract_metadata(self, component_id: str) -> ComponentMetadata:
        """Read and classify a component's default options."""
        import importlib

        from app.services.component_registry import component_registry_service

        summary = component_registry_service.get_component(component_id)
        parameters = []

        if summary is None:
            log.warning("Metadata requested for unknown component %s. Returning default empty metadata.", component_id)
        else:
            try:
                module = importlib.import_module(summary.module)
                cls = getattr(module, component_id)
                raw_options = dict(getattr(cls, "default_options", {}))
                parameters = [
                    _parse_param(name, str(value))
                    for name, value in raw_options.items()
                    if not name.startswith("_")
                ]
            except (ModuleNotFoundError, ImportError) as exc:
                log.warning("Could not load options metadata for %s: %s", component_id, exc)

        route_ids = [
            component.id
            for component in component_registry_service.list_components()
            if component.category == "routes"
        ]

        return ComponentMetadata(
            id=component_id,
            parameters=parameters,
            supportedRouteComponents=route_ids or None,
        )

    def get_metadata(self, component_id: str) -> ComponentMetadata:
        return registry_cache.get_or_set(
            self._cache_key(component_id),
            lambda: self.extract_metadata(component_id),
        )


metadata_service = MetadataService()


def _parse_param(name: str, value: str) -> ParameterSpec:
    normalized = value.strip()
    if normalized.lower() in ("true", "false"):
        return ParameterSpec(
            name=name,
            type="bool",
            default=normalized.lower(),
        )

    match = re.match(
        r"^-?[0-9]*\.?[0-9]+\s*(mm|um|nm|m)$",
        normalized,
        re.IGNORECASE,
    )
    if match:
        unit = match.group(1).lower()
        numeric = normalized[: -len(unit)].strip()
        return ParameterSpec(
            name=name,
            type="length",
            unit=unit,
            default=numeric,
        )

    try:
        float(normalized)
        return ParameterSpec(name=name, type="number", default=normalized)
    except ValueError:
        return ParameterSpec(name=name, type="string", default=value)
