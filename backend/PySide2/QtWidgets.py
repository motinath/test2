# Dummy QtWidgets mock module for PySide2

class QApplication:
    @staticmethod
    def instance():
        return None

def __getattr__(name):
    class DummyClass:
        def __init__(self, *args, **kwargs):
            pass
    DummyClass.__name__ = name
    return DummyClass
