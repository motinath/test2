# Dummy QtGui mock module for PySide2

def __getattr__(name):
    class DummyClass:
        def __init__(self, *args, **kwargs):
            pass
    DummyClass.__name__ = name
    return DummyClass
