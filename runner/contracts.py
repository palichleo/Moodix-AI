"""Worker configuration validation. Job validation lives in runner.registry (manifest driven)."""

from runner.registry import absolute, fields, number


def validate_config(config):
    fields(
        config,
        ('cacheRoot', 'outputRoot', 'manifestRoot', 'cacheGiB', 'warm'),
        ('cacheRoot', 'outputRoot'),
        'worker configuration',
    )
    # `manifestRoot`: where the manifest of each creation goes (its folder of creations keeps
    # only them); without it, beside the creation, as before.
    for key in ('cacheRoot', 'outputRoot', 'manifestRoot'):
        if key in config:
            absolute(config[key], key)
    result = dict(config)
    if 'cacheGiB' in result:
        number(result['cacheGiB'], 'cacheGiB', 0, 1024)
    # `warm`: the libraries of the creations imported as the worker starts (runner.warm).
    if type(result.get('warm', False)) is not bool:
        raise ValueError('Invalid warm flag')
    return result
