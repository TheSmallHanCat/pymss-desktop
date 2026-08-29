from __future__ import annotations

import importlib
import inspect
from typing import Any


def _filter_kwargs(values: dict[str, Any], target: Any) -> dict[str, Any]:
    signature = inspect.signature(target)
    accepted = {
        parameter.name
        for parameter in signature.parameters.values()
        if parameter.kind == parameter.POSITIONAL_OR_KEYWORD
    }
    return {key: value for key, value in values.items() if key in accepted}


def build_object_from_class_name(class_name: str, parent_class: type | None, *args: Any, **kwargs: Any) -> Any:
    module_name, separator, attribute_name = class_name.rpartition('.')
    if not separator:
        raise ValueError(f'Invalid class name: {class_name}')
    class_type = getattr(importlib.import_module(module_name), attribute_name)
    if parent_class is not None and not issubclass(class_type, parent_class):
        raise TypeError(f'{class_type} is not a subclass of {parent_class}')
    return class_type(*args, **_filter_kwargs(kwargs, class_type))
