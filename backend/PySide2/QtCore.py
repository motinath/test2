# Dummy QtCore mock module for PySide2

class QCoreApplication:
    @staticmethod
    def instance():
        return None
    @staticmethod
    def testAttribute(attr):
        return False
    @staticmethod
    def setAttribute(attr, value=True):
        pass

class QVersionNumber:
    @staticmethod
    def segments():
        return (5, 15, 2)

class QLibraryInfo:
    @staticmethod
    def version():
        return QVersionNumber()

class QtMeta(type):
    def __getattr__(cls, name):
        if name and name[0].isupper():
            class SubMeta(type):
                def __getattr__(self, sub_name):
                    return 0
            class Sub(metaclass=SubMeta):
                pass
            return Sub
        return 0

class Qt(metaclass=QtMeta):
    AA_ShareOpenGLContexts = 1
    AA_EnableHighDpiScaling = 2
    AA_UseHighDpiPixmaps = 3

class Signal:
    def __init__(self, *args, **kwargs):
        pass
    def connect(self, slot):
        pass
    def emit(self, *args, **kwargs):
        pass

def Slot(*args, **kwargs):
    def decorator(func):
        return func
    return decorator

def __getattr__(name):
    class DummyClass:
        def __init__(self, *args, **kwargs):
            pass
    DummyClass.__name__ = name
    return DummyClass

__version__ = '5.15.2'
