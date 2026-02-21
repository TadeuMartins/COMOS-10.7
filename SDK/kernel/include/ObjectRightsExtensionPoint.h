#pragma once

#include "ObjectRightsRestrictor.h"


namespace kernel::extensions
{
  /// <summary>
  /// COMOS kernel extension point for rights management.
  /// </summary>
  class ObjectRightsExtensionPoint
  {
  public:
    virtual void SetObjectRightsRestrictor(ObjectRightsRestrictor* rightsCalculator) = 0;

  protected:
    // This will prevent deletion from outside, through an interface pointer
    // It must be virtual due to possible multiple inheritance when implementing multiple interfaces
    virtual ~ObjectRightsExtensionPoint() = default;
  };
}
