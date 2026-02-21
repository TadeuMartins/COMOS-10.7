#pragma once

#include "DbCloseEventHandler.h"
#include "DbOpenEventHandler.h"


namespace kernel::extensions
{
  /// <summary>
  /// Event provider interface, through which a kernel extension can register for and unregister from certain events.
  /// </summary>
  class DbEventProvider
  {
  public:
    virtual void RegisterForDbOpen(DbOpenEventHandler* dbOpenEventHandler) = 0;
    virtual void RegisterForDbClose(DbCloseEventHandler* dbCloseEventHandler) = 0;
    virtual void DeregisterFromDbOpen(DbOpenEventHandler* dbOpenEventHandler) = 0;
    virtual void DeregisterFromDbClose(DbCloseEventHandler* dbCloseEventHandler) = 0;

  protected:
    // This will prevent deletion from outside, through an interface pointer
    // It must be virtual due to possible multiple inheritance when implementing multiple interfaces
    virtual ~DbEventProvider() = default;
  };
}
