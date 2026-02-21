#pragma once

#include "DbEventProvider_fwd.h"
#include "ObjectRightsExtensionPoint_fwd.h"
#include "ProjectEventProvider_fwd.h"

#include "dependency/IDependency.h"


namespace kernel::extensions
{
  /// <summary>
  /// Interface through which COMOS functionality and extension points are exposed to a COMOS kernel extension.
  /// </summary>
  class Gateway : public dependency::IDependency
  {
    friend struct std::default_delete<Gateway>; // in order to be manageable by unique_ptr
  public:
    virtual DbEventProvider& GetDbEventProvider() = 0;
    virtual ProjectEventProvider& GetProjectEventProvider() = 0;
    virtual ObjectRightsExtensionPoint& GetObjectRightsExtensionPoint() = 0;

  protected:
    // This will prevent deletion from outside, through an interface pointer
    // It must be virtual due to possible multiple inheritance when implementing multiple interfaces
    ~Gateway() override = default;
  };
}
