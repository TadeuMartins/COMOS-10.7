#pragma once

#ifndef OMIT_PLT_NAMESPACE_FOR_EXTENSION
namespace Plt
{
#endif

  struct IComosDUser;
  struct IComosBaseObject;

#ifndef OMIT_PLT_NAMESPACE_FOR_EXTENSION
}
#endif


namespace kernel::extensions
{
  /// <summary>
  /// Base interface for object rights restrictors, which can be implemented by an COMOS kernel extension to limit COMOS objects rights.
  /// </summary>
  class ObjectRightsRestrictor
  {
  public:
#ifndef OMIT_PLT_NAMESPACE_FOR_EXTENSION
    virtual long RestrictRights(Plt::IComosBaseObject* obj, Plt::IComosDUser* user, long staticRights) = 0;
#else
    virtual long RestrictRights(IComosBaseObject* obj, IComosDUser* user, long staticRights) = 0;
#endif

  protected:
    // This will prevent deletion from outside, through an interface pointer
    // It must be virtual due to possible multiple inheritance when implementing multiple interfaces
    virtual ~ObjectRightsRestrictor() = default;
  };
}
